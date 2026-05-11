/**
 * Returns a valid `access_token` for the Web Playback SDK (`getOAuthToken`).
 * Reads HttpOnly cookies set by `/api/auth/callback` — never exposes the
 * refresh token in JSON.
 *
 * Flow:
 * 1. If `svp_access_token` validates against `GET /v1/me` → return it.
 * 2. If missing, expired, or 401 → `POST` token with `refresh_token` grant.
 * 3. On success → rotate cookies (`svp_access_token`, optionally new
 *    `svp_refresh_token`) and return the new access token.
 * 4. On failure → clear auth cookies, 401 (SDK may fall back to embed).
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getCookie(
  request: Request,
  name: string
): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const parts = header.split(";");
  const prefix = `${name}=`;
  for (const part of parts) {
    const t = part.trim();
    if (t.startsWith(prefix)) {
      const raw = t.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
};

async function isAccessTokenValid(token: string): Promise<boolean> {
  const r = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return r.ok;
}

function applyAuthCookieHeaders(
  res: NextResponse,
  access: string,
  expiresIn: number,
  refresh?: string
) {
  res.cookies.set("svp_access_token", access, {
    ...COOKIE_BASE,
    maxAge: Math.max(60, expiresIn),
  });
  if (refresh) {
    res.cookies.set("svp_refresh_token", refresh, {
      ...COOKIE_BASE,
      maxAge: 60 * 60 * 24 * 30,
    });
  }
}

function clearAuthCookies(res: NextResponse) {
  res.cookies.set("svp_access_token", "", { ...COOKIE_BASE, maxAge: 0 });
  res.cookies.set("svp_refresh_token", "", { ...COOKIE_BASE, maxAge: 0 });
}

async function refreshSpotifyToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token?: string;
} | null> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[auth] missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET");
    return null;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.warn(
      "[auth] refresh failed",
      res.status,
      detail.slice(0, 200)
    );
    return null;
  }

  return (await res.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };
}

export async function GET(request: Request) {
  const accessToken = getCookie(request, "svp_access_token");
  const refreshToken = getCookie(request, "svp_refresh_token");

  if (!accessToken && !refreshToken) {
    return NextResponse.json({ error: "not_logged_in" }, { status: 401 });
  }

  if (accessToken) {
    const ok = await isAccessTokenValid(accessToken);
    if (ok) {
      return NextResponse.json({ access_token: accessToken });
    }
    console.log("[auth] access token invalid or expired, refreshing");
  } else {
    console.log("[auth] no access token in cookie, refreshing with refresh_token");
  }

  if (!refreshToken) {
    console.warn("[auth] no refresh token; cannot refresh");
    const res = NextResponse.json(
      { error: "not_logged_in" },
      { status: 401 }
    );
    clearAuthCookies(res);
    return res;
  }

  const refreshed = await refreshSpotifyToken(refreshToken);
  if (!refreshed) {
    const res = NextResponse.json(
      { error: "token_refresh_failed" },
      { status: 401 }
    );
    clearAuthCookies(res);
    return res;
  }

  console.log("[auth] spotify token refresh succeeded");

  const newRefresh = refreshed.refresh_token ?? refreshToken;
  const res = NextResponse.json({ access_token: refreshed.access_token });
  applyAuthCookieHeaders(
    res,
    refreshed.access_token,
    refreshed.expires_in,
    newRefresh
  );
  return res;
}
