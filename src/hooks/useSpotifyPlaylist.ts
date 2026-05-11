"use client";

import { useCallback, useRef, useState } from "react";
import type { Playlist } from "@/lib/types";
import { friendlyPlaylistEmbedError } from "@/lib/playlistLoadErrors";

/**
 * Live progress snapshot for an in-flight playlist load. `null` means
 * no fetch is in progress (either we haven't started one or the last
 * one has settled). `total` is known after the `meta` event; `done`
 * ticks up as individual tracks finish hydrating.
 */
export interface PlaylistFetchProgress {
  done: number;
  total: number;
  name: string | null;
}

export interface FetchPlaylistHookOptions {
  /** Guest Preview — fast path via `previewEmbedOnly` on the NDJSON API. */
  previewEmbedOnly?: boolean;
  /**
   * With `previewEmbedOnly`, load playlist + track list from the public embed
   * page only (no Web API playlist / tracks fetch).
   */
  tracksFromEmbedOnly?: boolean;
}

interface UseSpotifyPlaylistResult {
  loading: boolean;
  error: string | null;
  progress: PlaylistFetchProgress | null;
  fetchPlaylist: (
    input: string,
    options?: FetchPlaylistHookOptions
  ) => Promise<Playlist | null>;
}

/**
 * Client-side hook that streams playlist data from the server's
 * NDJSON endpoint so callers can render a "fetching N / total" UI.
 *
 * The signature stays compatible with the original non-streaming hook:
 * callers `await fetchPlaylist(input[, { previewEmbedOnly }])` and get back a `Playlist` (or
 * `null` on failure). Progress is exposed as the separate `progress`
 * field on the hook's return value.
 *
 * `credentials: "omit"` ensures the `svp_access_token` OAuth cookie is
 * NEVER sent with preview-mode requests — the preview path must work
 * identically whether or not the user has logged in.
 *
 * Pass `{ previewEmbedOnly: true, tracksFromEmbedOnly: true }` to load from the
 * public embed page only (paste + library row flows in this app).
 */
export function useSpotifyPlaylist(): UseSpotifyPlaylistResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<PlaylistFetchProgress | null>(null);

  // Used to tolerate React-18 strict-mode double-invocations and to
  // abandon the previous stream if the caller fires a new fetch
  // before the last one settles.
  const abortRef = useRef<AbortController | null>(null);

  const fetchPlaylist = useCallback(
    async (
      input: string,
      options?: FetchPlaylistHookOptions
    ): Promise<Playlist | null> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);
      setProgress(null);

      try {
        const res = await fetch("/api/spotify/playlist/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input,
            ...(options?.previewEmbedOnly ?
              { previewEmbedOnly: true }
            : {}),
            ...(options?.tracksFromEmbedOnly ?
              { tracksFromEmbedOnly: true }
            : {}),
          }),
          credentials: "omit",
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          // Error shape from the NDJSON endpoint when the input is
          // rejected up-front (400). Body is still JSON in that case.
          const payload = await res.json().catch(() => null);
          throw new Error(
            (payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error: unknown }).error)
              : null) ?? "Failed to load playlist"
          );
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let playlist: Playlist | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (!line) continue;

            let evt: unknown;
            try {
              evt = JSON.parse(line);
            } catch {
              continue;
            }

            if (typeof evt !== "object" || evt === null) continue;
            const e = evt as {
              phase?: string;
              total?: number;
              done?: number;
              name?: string;
              message?: string;
              playlist?: Playlist;
            };

            if (e.phase === "meta" && typeof e.total === "number") {
              setProgress({
                done: 0,
                total: e.total,
                name: e.name ?? null,
              });
            } else if (
              e.phase === "track" &&
              typeof e.done === "number" &&
              typeof e.total === "number"
            ) {
              setProgress({ done: e.done, total: e.total, name: null });
            } else if (e.phase === "done" && e.playlist) {
              playlist = e.playlist;
            } else if (e.phase === "error" && e.message) {
              throw new Error(e.message);
            }
          }
        }

        if (!playlist) throw new Error("Playlist stream ended unexpectedly");
        return playlist;
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") return null;
        const msg =
          err instanceof Error ? err.message : "Failed to load playlist";
        setError(friendlyError(msg));
        return null;
      } finally {
        // Only clear state if we weren't superseded by another fetch.
        if (abortRef.current === controller) {
          setLoading(false);
          setProgress(null);
          abortRef.current = null;
        }
      }
    },
    []
  );

  return { loading, error, progress, fetchPlaylist };
}

/**
 * Translates raw error strings (which sometimes leak Spotify response
 * bodies) into a short, user-facing message. The raw detail is still
 * in the console via the earlier `console.warn` calls.
 */
function friendlyError(raw: string): string {
  const fromEmbed = friendlyPlaylistEmbedError(raw);
  if (fromEmbed !== raw) return fromEmbed;
  if (/404/.test(raw) || /not found/i.test(raw)) {
    return "That playlist couldn't be found. Double-check the link.";
  }
  if (/403/.test(raw) || /forbidden/i.test(raw)) {
    return "This playlist isn't accessible — is it public?";
  }
  if (/401/.test(raw)) {
    return "Spotify rejected the request. Please try again.";
  }
  if (
    /ECONNREFUSED|ERR_CONNECTION_REFUSED|connection refused|Load failed/i.test(
      raw
    )
  ) {
    return "Couldn't connect to this app — make sure the dev server is running (for example npm run dev) and you're on the right port.";
  }
  if (/network|fetch|ECONNRESET|ENOTFOUND|Failed to fetch/i.test(raw)) {
    return "Network hiccup. Check your connection and try again.";
  }
  if (/missing `input`|extract.*playlist.*id/i.test(raw)) {
    return "Paste a Spotify playlist link to continue.";
  }
  // Generic fallback — avoid dumping raw JSON or stack traces at the user.
  return "Couldn't load that playlist. Try another link?";
}
