"use client";

/**
 * Placeholder client-side hook. The current architecture runs Client
 * Credentials Flow on the server route (/api/spotify/playlist), so no token
 * needs to be exposed to the browser. This hook exists so additional flows
 * (PKCE user auth, playback control, etc.) can be added later without
 * refactoring the consumers.
 */
export function useSpotifyAuth() {
  return {
    isAuthenticated: true,
    mode: "client-credentials" as const,
  };
}
