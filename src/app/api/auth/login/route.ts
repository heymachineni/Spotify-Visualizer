/**
 * Starts the Spotify Authorization Code Flow:
 *
 *   GET /api/auth/login  → 302  Spotify authorize URL
 *
 * The landing overlay's "Continue with Spotify" button links here. When
 * Spotify completes the flow it redirects back to `/api/auth/callback`,
 * which exchanges the `code` for an access token, stores it in an
 * HttpOnly cookie, and bounces the user back to `/` with a marker query
 * param the landing overlay uses to decide what to do next (premium →
 * enter playground, free → show preview-mode message).
 *
 * Redirect URI policy: the authorize URL MUST use the exact
 * `SPOTIFY_REDIRECT_URI` value that is whitelisted in the Spotify
 * developer dashboard. We never derive it from the request origin — that
 * caused `INVALID_CLIENT: Invalid redirect URI` when the dev server ran
 * on one hostname (`localhost`) and the dashboard had another
 * (`127.0.0.1`). If the env var is missing we fail fast instead.
 *
 * Only the minimum scopes needed for `/v1/me` are requested. Adding
 * playback control later just means extending the `scope` string.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Scopes: identity is used by /v1/me; Web Playback needs streaming +
// user playback state. Library scopes load playlists, saved tracks, and
// recently played for the user-library sheet.
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "streaming",
  "user-modify-playback-state",
  "user-read-playback-state",
  "playlist-read-private",
  "user-library-read",
  "user-read-recently-played",
].join(" ");

export async function GET(request: Request) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  if (!clientId) {
    return NextResponse.json(
      { error: "Missing SPOTIFY_CLIENT_ID in .env.local" },
      { status: 500 }
    );
  }
  if (!redirectUri) {
    return NextResponse.json(
      {
        error:
          "Missing SPOTIFY_REDIRECT_URI in .env.local. Set it to the same value whitelisted in the Spotify dashboard, e.g. http://127.0.0.1:3000/api/auth/callback",
      },
      { status: 500 }
    );
  }
  // Trim to avoid false mismatches from trailing newlines/whitespace in .env
  const redirectUriTrimmed = redirectUri.trim();

  const state = crypto.randomBytes(16).toString("hex");

  // --- DEBUG LOGGING -----------------------------------------------------
  // Surfaces the values that determine whether /api/auth/callback can
  // validate the CSRF handshake. The request's host is logged too so we
  // can see when the user hits the dev server on a different hostname
  // than SPOTIFY_REDIRECT_URI, which is the most common cause of the
  // "invalid_state" failure (the state cookie is scoped to the hostname
  // the login route was called on, but Spotify redirects back to the
  // hostname embedded in SPOTIFY_REDIRECT_URI — different origin ⇒ the
  // browser never sends the cookie back to the callback).
  const requestUrl = new URL(request.url);
  // Next.js can rewrite `request.url` to a canonical form (e.g. localhost
  // when the user opened 127.0.0.1). Use the Host the browser sent, not
  // `request.url` alone, for the dev guard and CSRF-cookie scoping.
  const forwarded = request.headers.get("x-forwarded-host");
  const hostFromRequestLine =
    forwarded?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    requestUrl.host;
  console.log("[oauth] generated state:", state);
  console.log("[oauth] setting svp_oauth_state cookie");
  console.log("[oauth] login host (url /request.url/):", requestUrl.host);
  console.log(
    "[oauth] login host (Host / X-Forwarded-Host, used for guard):",
    hostFromRequestLine
  );
  console.log("[oauth] redirect_uri used in authorize:", redirectUriTrimmed);
  const normalizeHost = (h: string) =>
    h.replace(/^https?:\/\//, "").trim().toLowerCase();
  const redirectUrlParsed = (() => {
    try {
      return new URL(redirectUriTrimmed);
    } catch {
      return null;
    }
  })();
  const redirectHostRaw = redirectUrlParsed?.host ?? "<invalid SPOTIFY_REDIRECT_URI>";
  const redirectHostNormalized = normalizeHost(redirectHostRaw);
  const urlHostNorm = normalizeHost(requestUrl.host);
  let requestHost = normalizeHost(hostFromRequestLine);
  // Prefer the request line when it already matches the dashboard host
  // (Next can still send Host: localhost while /request.url/ is 127.0.0.1).
  if (urlHostNorm === redirectHostNormalized) {
    requestHost = urlHostNorm;
  } else if (requestHost !== redirectHostNormalized) {
    const ref = request.headers.get("referer");
    if (ref) {
      try {
        const refHostNorm = normalizeHost(new URL(ref).host);
        if (refHostNorm === redirectHostNormalized) {
          requestHost = refHostNorm;
          console.log(
            "[oauth] login: Host/URL said",
            hostFromRequestLine,
            "but Referer host matches SPOTIFY — treating as",
            new URL(ref).host
          );
        }
      } catch {
        // ignore malformed referer
      }
    }
  }
  if (requestHost !== redirectHostNormalized) {
    console.warn(
      "[oauth] hostname mismatch:",
      requestHost,
      "vs",
      redirectHostNormalized,
      `(url host: ${requestUrl.host}, guard host: ${hostFromRequestLine}, redirect URI: ${redirectHostRaw})`
    );
    // Only block the only dev bug we can fix with certainty: the user
    // is on "localhost" but the dashboard/env use "127.0.0.1" (or the
    // reverse). Other apparent mismatches (ports, proxy Host headers) can
    // false-positive — warn only; do not 400.
    const isLocalMismatch =
      (requestHost.includes("localhost") &&
        redirectHostNormalized.includes("127.0.0.1")) ||
      (requestHost.includes("127.0.0.1") &&
        redirectHostNormalized.includes("localhost"));
    if (isLocalMismatch && process.env.NODE_ENV !== "production") {
      const redirectUriOrigin = redirectUrlParsed?.origin ?? "http://127.0.0.1:3000";
      return new Response(
        `Open the app at ${redirectUriOrigin} instead of http://${requestHost}.\n\n` +
          `Spotify OAuth cookies are scoped by hostname, and your SPOTIFY_REDIRECT_URI ` +
          `is set to "${redirectHostRaw}". Browsers treat "localhost" and "127.0.0.1" as ` +
          `different origins, so the CSRF cookie set here would never be sent to the ` +
          `callback — the login would fail with "invalid_state".`,
        {
          status: 400,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }
      );
    }
  }
  // -----------------------------------------------------------------------

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: redirectUriTrimmed,
    state,
    show_dialog: "false",
  });

  const res = NextResponse.redirect(
    `https://accounts.spotify.com/authorize?${params.toString()}`
  );
  // Short-lived CSRF cookie — validated on callback.
  res.cookies.set("svp_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60, // 10 minutes
  });
  return res;
}
