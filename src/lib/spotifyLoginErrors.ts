/**
 * User-facing copy for `/?login=error&reason=…` (OAuth callback) and related flows.
 * Production: short, calm language. Development: extra hints for localhost / env.
 */

function dev(): boolean {
  return process.env.NODE_ENV === "development";
}

export function oauthDevDetail(): boolean {
  return dev();
}

export function spotifyCallbackErrorMessage(reason: string): string {
  const r = (reason || "unknown").toLowerCase().trim();

  if (r === "invalid_state") {
    if (dev()) {
      return [
        "Login couldn’t confirm your session (invalid_state).",
        "Use the same host in the browser as in SPOTIFY_REDIRECT_URI (e.g. 127.0.0.1 vs localhost must match).",
        "Then click “Continue with Spotify” again. Preview Mode still works below.",
      ].join(" ");
    }
    return "Sign-in didn’t finish. Please tap Continue with Spotify again, or use Try Preview below.";
  }

  if (r === "token_exchange_failed") {
    if (dev()) {
      return [
        "Spotify rejected the code exchange. Check SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, and that the dashboard Redirect URI matches SPOTIFY_REDIRECT_URI exactly.",
        "Preview Mode still works below.",
      ].join(" ");
    }
    return "Spotify couldn’t complete sign-in. Try again in a moment, or use Try Preview below.";
  }

  if (r === "missing_credentials") {
    return dev()
      ? "Server is missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET. Add them to .env.local and restart the dev server."
      : "Sign-in isn’t available on this site right now. Try Preview below.";
  }

  if (r === "missing_redirect_uri") {
    return dev()
      ? "Set SPOTIFY_REDIRECT_URI in .env.local to the callback URL in your Spotify app (e.g. http://127.0.0.1:3000/api/auth/callback)."
      : "Sign-in isn’t configured correctly. Try Preview below.";
  }

  if (r === "access_denied") {
    return "Spotify sign-in was cancelled. You can try again or use Try Preview below.";
  }

  if (r === "server_error" || r === "temporarily_unavailable") {
    return "Spotify had a brief problem. Try Continue with Spotify again, or use Try Preview below.";
  }

  if (r === "invalid_scope") {
    return dev()
      ? "The app is requesting a scope your Spotify app doesn’t allow. Check scopes in the developer dashboard, or use Try Preview below."
      : "Sign-in isn’t available with this app setup. Try Preview below.";
  }

  if (r === "invalid_client") {
    return dev()
      ? "Spotify didn’t accept the app credentials (invalid_client). Check Client ID/secret in the dashboard and .env.local."
      : "Sign-in isn’t available right now. Try Preview below.";
  }

  return dev()
    ? `Login didn’t complete (${reason}). Try again or use Try Preview below.`
    : "Something went wrong with sign-in. Try again or use Try Preview below.";
}
