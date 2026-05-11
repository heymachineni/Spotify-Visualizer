/**
 * Spotify OAuth callback. Exchanges the `code` query param for an
 * access token and stores it in an HttpOnly cookie so subsequent
 * requests from the browser (e.g. `/api/auth/me`) can use it without
 * exposing the token to client-side JS.
 *
 * On success: 302 → `/?login=success`
 * On failure: 302 → `/?login=error&reason=...`
 *
 * This is an intentionally minimal "stub" — no refresh-token rotation,
 * no persistent session, no DB. Good enough to detect Premium vs Free
 * on the landing screen.
 */
import { NextResponse } from "next/server";
import { getRequestCookie } from "@/lib/server/requestCookies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * We intentionally do **not** call `GET /v1/me` here. Spotify rate-limits
 * that endpoint aggressively; doing token exchange + `/me` in this
 * request while the browser almost simultaneously calls `/api/auth/me`
 * produced back-to-back `/v1/me` traffic and reliable HTTP 429 failures.
 * Profile is fetched once from `/api/auth/me` after redirect (with a
 * short client-side delay + server-side request coalescing).
 */

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // The final `/?login=…` redirect MUST land on the same origin the
  // user started the login flow on — otherwise the HttpOnly cookies
  // we're about to set (svp_access_token, svp_refresh_token) will be
  // orphaned on the wrong hostname and /api/auth/me will come back
  // 401. `url.origin` mirrors whatever host Spotify hit on the way
  // back, which can be silently rewritten by proxies or by the
  // accidental localhost/127.0.0.1 flip. We instead derive it from
  // SPOTIFY_REDIRECT_URI, which is the single source of truth for the
  // hostname used throughout the OAuth handshake.
  const appOrigin = (() => {
    const raw = process.env.SPOTIFY_REDIRECT_URI;
    if (raw) {
      try {
        return new URL(raw).origin;
      } catch {
        console.warn(
          "[oauth] SPOTIFY_REDIRECT_URI is not a valid URL:",
          raw
        );
      }
    }
    return url.origin;
  })();
  console.log("[oauth] redirect origin for /?login=…:", appOrigin);
  if (appOrigin !== url.origin) {
    console.warn(
      `[oauth] callback hit origin "${url.origin}" but we're redirecting back to "${appOrigin}" (derived from SPOTIFY_REDIRECT_URI) to keep cookies on the right host`
    );
  }

  if (error) {
    // Surface the raw Spotify-provided error code in the server log
    // so `server_error`, `access_denied`, `invalid_scope`, etc. are
    // easy to diagnose. We also echo it back via the `reason` query
    // param so the landing overlay can render a friendly message.
    console.error("[spotify oauth error]", error);
    return NextResponse.redirect(
      `${appOrigin}/?login=error&reason=${encodeURIComponent(error)}`
    );
  }

  // CSRF: state cookie must match the one Spotify echoed back.
  const rawCookieHeader = request.headers.get("cookie") ?? "";
  const cookieState = getRequestCookie(request, "svp_oauth_state");

  // --- DEBUG LOGGING -----------------------------------------------------
  // Dump the three inputs that feed the invalid_state branch so we can
  // tell, at a glance, WHICH input is missing or mismatched. Tokens
  // are truncated — we only need enough characters to eyeball equality,
  // not the whole secret.
  const truncate = (s: string | null | undefined, n = 8) =>
    s ? `${s.slice(0, n)}…(len=${s.length})` : "<null>";
  console.log("[oauth] callback host:", url.host);
  console.log(
    "[oauth] callback SPOTIFY_REDIRECT_URI:",
    process.env.SPOTIFY_REDIRECT_URI ?? "<unset>"
  );
  console.log("[oauth] callback code exists:", Boolean(code));
  console.log("[oauth] callback state param:", truncate(stateParam));
  console.log("[oauth] state cookie value :", truncate(cookieState));
  console.log(
    "[oauth] cookie header present:",
    rawCookieHeader.length > 0,
    "(bytes:",
    rawCookieHeader.length + ")"
  );
  if (!code) {
    console.warn("[oauth] missing code");
  }
  if (!stateParam) {
    console.warn("[oauth] missing state param");
  }
  if (!cookieState) {
    console.warn(
      "[oauth] missing state cookie (browser did not send svp_oauth_state to this host)"
    );
  }
  if (stateParam && cookieState && stateParam !== cookieState) {
    console.warn("[oauth] state mismatch");
  }
  // -----------------------------------------------------------------------

  if (!code || !stateParam || !cookieState || stateParam !== cookieState) {
    return NextResponse.redirect(`${appOrigin}/?login=error&reason=invalid_state`);
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(
      `${appOrigin}/?login=error&reason=missing_credentials`
    );
  }

  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  if (!redirectUri) {
    // Must be identical to the value used at /api/auth/login; if it's
    // missing here the token exchange would 400 anyway.
    return NextResponse.redirect(
      `${appOrigin}/?login=error&reason=missing_redirect_uri`
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  // Must exactly match the redirect_uri sent to /authorize in
  // /api/auth/login — Spotify compares byte-for-byte. We log it here
  // so both halves of the handshake are visible in the same terminal.
  console.log("[oauth] token exchange redirect_uri:", redirectUri);

  const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => "");
    console.warn(
      `[auth] token exchange failed: ${tokenRes.status} ${detail.slice(0, 200)}`
    );
    return NextResponse.redirect(
      `${appOrigin}/?login=error&reason=token_exchange_failed`
    );
  }

  const json = (await tokenRes.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
    scope: string;
    token_type: string;
  };

  const res = NextResponse.redirect(`${appOrigin}/?login=success`);

  // Store the access token in an HttpOnly cookie for the duration
  // Spotify said it'd be valid. The refresh token is stored too so a
  // later iteration can rotate without re-prompting — but nothing in
  // this pass uses it yet.
  res.cookies.set("svp_access_token", json.access_token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.max(60, json.expires_in),
  });
  if (json.refresh_token) {
    res.cookies.set("svp_refresh_token", json.refresh_token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30d
    });
  }
  // Done with the CSRF cookie.
  res.cookies.set("svp_oauth_state", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });

  return res;
}
