/**
 * Proxies `GET /v1/me` using the OAuth access token stored in the
 * HttpOnly `svp_access_token` cookie set during the login callback.
 * Returns a tiny subset the landing overlay actually needs:
 *
 *   { product: "premium" | "free" | "open", displayName, id }
 *
 * `product` drives the post-login branch on the landing screen:
 *   - "premium" → enter playground with Playback SDK capabilities
 *   - anything else → show the free-account message and route to
 *     preview mode.
 *
 * Caches a successful `GET /v1/me` in the `svp_me_snapshot` HttpOnly
 * cookie so repeat visits skip Spotify until the cookie expires.
 *
 * **Important:** The OAuth callback intentionally does *not* call `/v1/me`
 * (that doubled traffic with this route and tripped Spotify 429). The
 * client waits a few seconds after redirect before the first `/api/auth/me`.
 * Concurrent requests for the same access token also share one upstream
 * `GET /v1/me` (dev Strict Mode / double-fetch).
 */
import { NextResponse } from "next/server";
import { getRequestCookie } from "@/lib/server/requestCookies";
import {
  clearMeSnapshotCookie,
  parseMeSnapshotCookie,
  setMeSnapshotCookie,
  SVP_ME_SNAPSHOT,
} from "@/lib/server/meSnapshotCookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function fetchSpotifyMe(token: string) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const bodyText = await res.text().catch(() => "");
  return { res, bodyText };
}

/** Same-token parallel `/api/auth/me` calls share one upstream Spotify fetch. */
const inflightMe = new Map<
  string,
  Promise<{ res: Response; bodyText: string }>
>();

function meInflightKey(token: string) {
  return token.slice(0, 48);
}

async function fetchSpotifyMeWithRetries(
  token: string
): Promise<{ res: Response; bodyText: string }> {
  let { res, bodyText } = await fetchSpotifyMe(token);

  for (let attempt = 0; attempt < 2 && res.status === 429; attempt++) {
    const ra = res.headers.get("Retry-After");
    const fromHeader = parseInt(ra || "", 10);
    const sec = Number.isFinite(fromHeader) ? fromHeader : 2 + attempt * 2;
    // Give Spotify breathing room after token exchange; cap so dev isn't blocked forever.
    const waitMs = Math.min(30_000, Math.max(3_000, sec * 1_000));
    console.warn(
      `[auth/me] Spotify 429 (rate limit) — retry ${attempt + 1}/2 after ${waitMs}ms`
    );
    await new Promise((r) => setTimeout(r, waitMs));
    ({ res, bodyText } = await fetchSpotifyMe(token));
  }

  return { res, bodyText };
}

async function dedupedSpotifyMe(
  token: string
): Promise<{ res: Response; bodyText: string }> {
  const key = meInflightKey(token);
  const existing = inflightMe.get(key);
  if (existing) return existing;

  const p = fetchSpotifyMeWithRetries(token).finally(() => {
    if (inflightMe.get(key) === p) inflightMe.delete(key);
  });
  inflightMe.set(key, p);
  return p;
}

export async function GET(request: Request) {
  const tokenRaw = getRequestCookie(request, "svp_access_token");
  const token = tokenRaw?.trim();

  const host = new URL(request.url).host;
  console.log(
    "[oauth] /me cookie present:",
    Boolean(token),
    "host:",
    host,
    "tokenLength:",
    token?.length ?? 0
  );

  if (!token) {
    return NextResponse.json({ error: "not_logged_in" }, { status: 401 });
  }

  const snapRaw = getRequestCookie(request, SVP_ME_SNAPSHOT);
  const fromSnap = parseMeSnapshotCookie(snapRaw);
  if (fromSnap) {
    return NextResponse.json({
      id: fromSnap.id,
      displayName: fromSnap.displayName,
      product: fromSnap.product,
    });
  }

  const { res, bodyText } = await dedupedSpotifyMe(token);

  if (res.status === 401) {
    console.warn(
      "[auth/me] Spotify /v1/me 401 — token invalid or expired. body:",
      bodyText.slice(0, 300)
    );
    const r = NextResponse.json({ error: "token_expired" }, { status: 401 });
    r.cookies.set("svp_access_token", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    clearMeSnapshotCookie(r);
    return r;
  }

  if (res.status === 429) {
    let detail = bodyText.slice(0, 200);
    try {
      const j = JSON.parse(bodyText) as { error?: { message?: string } };
      if (j?.error?.message) detail = j.error.message;
    } catch {
      /* */
    }
    console.warn(
      "[auth/me] Spotify /v1/me still 429 after retry — client should wait and refresh:",
      detail
    );
    const ra = res.headers.get("Retry-After");
    const out = NextResponse.json(
      {
        error: "rate_limited",
        status: 429,
        detail,
      },
      { status: 503 }
    );
    if (ra) out.headers.set("Retry-After", ra);
    else out.headers.set("Retry-After", "60");
    return out;
  }

  if (!res.ok) {
    let detail = bodyText.slice(0, 400);
    try {
      const j = JSON.parse(bodyText) as {
        error?: { message?: string; reason?: string };
      };
      const m = j?.error?.message ?? j?.error?.reason;
      if (m) detail = m;
    } catch {
      /* keep raw slice */
    }
    console.error("[auth/me] Spotify /v1/me failed:", res.status, detail);
    return NextResponse.json(
      {
        error: "spotify_error",
        status: res.status,
        detail,
      },
      { status: 502 }
    );
  }

  let me: { id: string; display_name: string | null; product: string };
  try {
    me = JSON.parse(bodyText) as typeof me;
  } catch (e) {
    console.error("[auth/me] JSON parse error for /v1/me body:", e);
    return NextResponse.json(
      { error: "invalid_spotify_response" },
      { status: 502 }
    );
  }

  const out = NextResponse.json({
    id: me.id,
    displayName: me.display_name,
    product: me.product,
  });
  setMeSnapshotCookie(
    out,
    {
      id: me.id,
      displayName: me.display_name,
      product: me.product,
    },
    3600
  );
  return out;
}
