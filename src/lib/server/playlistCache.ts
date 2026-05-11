import { createHash } from "node:crypto";
import type { Playlist } from "@/lib/types";

type Entry = { playlist: Playlist; expiresAt: number };
const store = new Map<string, Entry>();
const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 80;

function stableUserKeyFromToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 24);
}

function cacheKey(userKey: string, playlistId: string): string {
  return `${userKey}::${playlistId}`;
}

export function cacheKeyForRequest(accessToken: string): string {
  return stableUserKeyFromToken(accessToken);
}

export function getCachedPlaylist(
  userKey: string,
  playlistId: string
): Playlist | null {
  const k = cacheKey(userKey, playlistId);
  const e = store.get(k);
  if (!e) return null;
  if (Date.now() > e.expiresAt) {
    store.delete(k);
    return null;
  }
  return e.playlist;
}

export function setCachedPlaylist(
  userKey: string,
  playlistId: string,
  playlist: Playlist
): void {
  while (store.size >= MAX_ENTRIES) {
    const first = store.keys().next().value;
    if (first === undefined) break;
    store.delete(first);
  }
  const k = cacheKey(userKey, playlistId);
  store.set(k, { playlist, expiresAt: Date.now() + TTL_MS });
}
