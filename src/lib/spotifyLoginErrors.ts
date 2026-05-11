/**
 * User-facing copy for `/?login=error&reason=…` (OAuth callback) and related flows.
 */
export function spotifyCallbackErrorMessage(reason: string): string {
  const r = (reason || "unknown").toLowerCase().trim();

  if (r === "invalid_state") {
    return [
      "Login couldn’t confirm your session (invalid_state).",
      "The browser must use the same host as in SPOTIFY_REDIRECT_URI. If the redirect is http://127.0.0.1:3000/…, open the app at 127.0.0.1 — not “localhost” (and vice versa).",
      "Then click “Continue with Spotify” again. Preview Mode still works below.",
    ].join(" ");
  }

  if (r === "token_exchange_failed") {
    return [
      "Spotify rejected the code exchange. Check that SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local match the Spotify Developer Dashboard, and that the app’s Redirect URI is identical to SPOTIFY_REDIRECT_URI (scheme, host, path, no trailing slash mismatch).",
      "Preview Mode still works below.",
    ].join(" ");
  }

  if (r === "missing_credentials") {
    return "Server is missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Add them to .env.local and restart the dev server.";
  }

  if (r === "missing_redirect_uri") {
    return "Set SPOTIFY_REDIRECT_URI in .env.local to the same callback URL you added in the Spotify app (e.g. http://127.0.0.1:3000/api/auth/callback).";
  }

  if (r === "access_denied") {
    return "Spotify sign-in was cancelled or not approved. You can try again or use Preview Mode below.";
  }

  if (r === "server_error" || r === "temporarily_unavailable") {
    return "Spotify had a temporary error. Wait a moment and try “Continue with Spotify” again, or use Preview Mode below.";
  }

  if (r === "invalid_scope") {
    return "The app is requesting a scope your Spotify app doesn’t allow. Check scopes in the developer dashboard, or use Preview Mode below.";
  }

  if (r === "invalid_client") {
    return "Spotify didn’t accept the app credentials (invalid_client). Verify Client ID/secret in the dashboard and in .env.local.";
  }

  // Unknown reason from our redirect or from Spotify
  return `Login didn’t complete (${reason}). You can try again, or use Preview Mode below.`;
}
