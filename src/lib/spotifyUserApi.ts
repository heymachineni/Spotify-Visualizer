/**
 * User OAuth Web API calls (server-only). All requests use a user access
 * token — never the client credentials flow.
 */
import type { NormalizedTrack, Playlist } from "./types";
import { fetchPlaylist, fetchPlaylistTracksOnly } from "./spotify";
import {
  mapSpotifyPlaylistItemToNormalized,
  mapSpotifyWebApiTrack,
} from "./mapSpotifyWebApiTrack";
import { SVP_PLAYLIST_LIKED_ID, SVP_PLAYLIST_RECENT_ID } from "./spotifyUserIds";

const API = "https://api.spotify.com/v1";

export { SVP_PLAYLIST_LIKED_ID, SVP_PLAYLIST_RECENT_ID } from "./spotifyUserIds";

async function spotifyGet(
  accessToken: string,
  pathOrUrl: string
): Promise<Response> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${API}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
}

/**
 * Spotify often answers `429` with `Retry-After`. Retrying the **same**
 * lightweight request is correct; branching into full-playlist + per-track
 * hydration (the old `loadTracksWhenWebApiBlocks` path) multiplies traffic and
 * worsens limits — and can wedge the Next route until the client sees
 * `TypeError: Failed to fetch` when the connection drops.
 */
async function spotifyGetWith429Backoff(
  accessToken: string,
  pathOrUrl: string
): Promise<Response> {
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await spotifyGet(accessToken, pathOrUrl);
    if (res.status !== 429) return res;
    if (attempt === maxAttempts - 1) return res;
    let waitMs = 1000 * (attempt + 1);
    const ra = res.headers.get("retry-after");
    if (ra) {
      const sec = Number(ra);
      if (Number.isFinite(sec)) {
        waitMs = Math.min(60_000, Math.max(500, sec * 1000));
      }
    }
    await res.text().catch(() => "");
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return spotifyGet(accessToken, pathOrUrl);
}

export async function fetchUserProfile(
  accessToken: string
): Promise<{ name: string; image: string | null }> {
  const res = await spotifyGet(accessToken, "/me");
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`GET /v1/me failed: ${res.status} ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    display_name: string | null;
    images?: { url: string }[];
  };
  return {
    name: data.display_name ?? "Spotify user",
    image: data.images?.[0]?.url ?? null,
  };
}

type PlaylistItem = { id: string; name: string; coverImage: string | null };

export async function fetchAllUserPlaylists(
  accessToken: string
): Promise<PlaylistItem[]> {
  const out: PlaylistItem[] = [];
  let url: string | null = `${API}/me/playlists?limit=50&offset=0`;

  for (let page = 0; page < 200 && url; page++) {
    const res = await spotifyGet(accessToken, url);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(
        `GET /v1/me/playlists failed: ${res.status} ${t.slice(0, 200)}`
      );
    }
    const data = (await res.json()) as {
      items: Array<{
        id: string;
        name: string;
        images?: { url: string }[];
      }>;
      next: string | null;
    };
    for (const p of data.items ?? []) {
      if (!p?.id) continue;
      out.push({
        id: p.id,
        name: p.name,
        coverImage: p.images?.[0]?.url ?? null,
      });
    }
    url = data.next;
  }
  return out;
}

function normalizePageTracks(items: Array<{ track: unknown } | null>) {
  const acc: NormalizedTrack[] = [];
  for (const item of items) {
    if (!item?.track || typeof item.track !== "object") continue;
    const t = item.track as Parameters<typeof mapSpotifyWebApiTrack>[0];
    const n = mapSpotifyWebApiTrack(t);
    if (n) acc.push(n);
  }
  return acc;
}

function normalizePlaylistPageItems(
  items: Array<{ track: unknown; episode?: unknown } | null> | null
): NormalizedTrack[] {
  const acc: NormalizedTrack[] = [];
  for (const item of items ?? []) {
    const n = mapSpotifyPlaylistItemToNormalized(item);
    if (n) acc.push(n);
  }
  return acc;
}

/**
 * One Spotify `GET /v1/me/tracks` page (max limit 50 per API). Used by
 * `GET /api/spotify/user/library?type=liked` and client progressive loading.
 */
export type SavedTracksPageResult = {
  tracks: NormalizedTrack[];
  total: number;
  nextOffset: number | null;
};

const SPOTIFY_SAVED_MAX = 50;

export async function fetchSavedTracksPage(
  accessToken: string,
  options: { limit: number; offset: number }
): Promise<SavedTracksPageResult> {
  const cap = Math.min(
    SPOTIFY_SAVED_MAX,
    Math.max(1, Math.floor(options.limit))
  );
  const offset = Math.max(0, Math.floor(options.offset));
  const res = await spotifyGet(
    accessToken,
    `${API}/me/tracks?limit=${encodeURIComponent(
      String(cap)
    )}&offset=${encodeURIComponent(String(offset))}`
  );
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(
      `GET /v1/me/tracks failed: ${res.status} ${t.slice(0, 200)}`
    );
  }
  const data = (await res.json()) as {
    items: Array<{ track: unknown } | null>;
    total?: number;
  };
  const tracks = normalizePageTracks(data.items ?? []);
  const total =
    typeof data.total === "number" && data.total >= 0
      ? data.total
      : offset + tracks.length;
  const end = offset + tracks.length;
  const nextOffset: number | null = end < total ? end : null;
  return { tracks, total, nextOffset };
}

export function buildLikedPlaylist(tracks: NormalizedTrack[]): Playlist {
  return {
    id: SVP_PLAYLIST_LIKED_ID,
    name: "Liked Songs",
    coverImage: null,
    description: "Your saved tracks",
    tracks,
  };
}

/**
 * Deduplicate by track id, preserving first-seen order (Spotify order is
 * usually newest-first; dedupe makes a sensible queue).
 */
export function dedupeTracksFirstWins(
  tracks: NormalizedTrack[]
): NormalizedTrack[] {
  const seen = new Set<string>();
  const out: NormalizedTrack[] = [];
  for (const t of tracks) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

const RECENT_MAX_PAGES = 4;

export async function fetchRecentTracks(
  accessToken: string
): Promise<NormalizedTrack[]> {
  const raw: NormalizedTrack[] = [];
  let url: string | null = `${API}/me/player/recently-played?limit=50`;

  for (let page = 0; page < RECENT_MAX_PAGES && url; page++) {
    const res = await spotifyGet(accessToken, url);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(
        `GET /v1/me/player/recently-played failed: ${res.status} ${t.slice(0, 200)}`
      );
    }
    const data = (await res.json()) as {
      items: Array<{
        track: Parameters<typeof mapSpotifyWebApiTrack>[0] | null;
      } | null>;
      next: string | null;
    };
    for (const item of data.items ?? []) {
      const t = item?.track ? mapSpotifyWebApiTrack(item.track) : null;
      if (t) raw.push(t);
    }
    url = data.next;
  }
  return dedupeTracksFirstWins(raw);
}

export function buildRecentPlaylist(tracks: NormalizedTrack[]): Playlist {
  return {
    id: SVP_PLAYLIST_RECENT_ID,
    name: "Recently Played",
    coverImage: null,
    description: "Recently played tracks",
    tracks,
  };
}

/**
 * When user-token `GET /playlists/{id}/tracks` is blocked (403) or the full
 * `fetchPlaylist` path fails: `fetchPlaylist` first loads metadata with
 * **client** credentials, which 404s for private lists before embed runs.
 * This tries embed+hydrate for tracks only, then the full public pipeline.
 */
async function loadTracksWhenWebApiBlocks(
  playlistId: string
): Promise<NormalizedTrack[]> {
  try {
    return await fetchPlaylistTracksOnly(playlistId, {});
  } catch (err) {
    console.warn(
      "[spotifyUser] fetchPlaylistTracksOnly failed; trying fetchPlaylist (public list)",
      err
    );
    const full = await fetchPlaylist(playlistId, {});
    return full.tracks;
  }
}

const USER_PL_FIELDS = encodeURIComponent("id,name,description,images");

const MAX_USER_PL_FULL_FETCH_PAGES = 400;

/**
 * Full track list using the **user** access token (private playlists, relinked
 * tracks). Used when paged `/tracks?fields=…` fails or when the 403 fallback
 * must not rely on client-credentials + embed (which only works for public lists).
 */
async function fetchAllPlaylistTracksWithUserToken(
  accessToken: string,
  playlistId: string
): Promise<NormalizedTrack[]> {
  const all: NormalizedTrack[] = [];
  let offset = 0;
  const limit = 50;
  for (let p = 0; p < MAX_USER_PL_FULL_FETCH_PAGES; p++) {
    const url = buildUserPlaylistTracksUrl(playlistId, offset, limit);
    const res = await spotifyGet(accessToken, url);
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      if (p === 0) {
        throw new Error(
          `GET /v1/playlists/{id}/tracks (user, no fields) failed: ${res.status} ${t.slice(0, 200)}`
        );
      }
      break;
    }
    const data = (await res.json()) as {
      items?: Array<{ track: unknown; episode?: unknown } | null>;
      total?: number;
    };
    const items = data.items ?? [];
    const batch = normalizePlaylistPageItems(items);
    all.push(...batch);
    const n = items.length;
    if (n < limit) break;
    const total = data.total;
    if (typeof total === "number" && offset + n >= total) break;
    offset += limit;
  }
  return all;
}

/**
 * User-access-token reads of `/playlists/{id}/tracks` — **no** `fields` filter.
 * Filtered responses have caused empty `items` with some account/region shapes;
 * one full shape + `market=from_token` is the reliable path.
 */
function buildUserPlaylistTracksUrl(
  playlistId: string,
  offset: number,
  limit: number
): string {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    market: "from_token",
    additional_types: "track,episode",
  });
  return `${API}/playlists/${encodeURIComponent(playlistId)}/tracks?${params.toString()}`;
}

export type UserPlaylistPageResult = {
  id: string;
  name: string;
  description?: string;
  coverImage: string | null;
  tracks: NormalizedTrack[];
  total: number;
  nextOffset: number | null;
};

async function fetchUserPlaylistMeta(
  accessToken: string,
  playlistId: string
): Promise<{
  id: string;
  name: string;
  description: string | null;
  coverImage: string | null;
}> {
  const metaRes = await spotifyGetWith429Backoff(
    accessToken,
    `/playlists/${encodeURIComponent(playlistId)}?fields=${USER_PL_FIELDS}`
  );
  if (!metaRes.ok) {
    const t = await metaRes.text().catch(() => "");
    throw new Error(
      `GET /v1/playlists/{id} failed: ${metaRes.status} ${t.slice(0, 200)}`
    );
  }
  const meta = (await metaRes.json()) as {
    id: string;
    name: string;
    description: string | null;
    images?: { url: string }[];
  };
  return {
    id: meta.id,
    name: meta.name,
    description: meta.description,
    coverImage: meta.images?.[0]?.url ?? null,
  };
}

/**
 * One page of a user’s playlist (max 50 items per call). For `offset > 0`,
 * `name` / `description` / `coverImage` are empty — the client should keep
 * metadata from the first `offset=0` response. On `offset === 0` and
 * 403/404 on tracks, falls back to full user-token pagination (private
 * lists), then embed+hydrate for public-only edge cases.
 *
 * **429** is handled with bounded `Retry-After` backoff only — it does **not**
 * trigger the heavy embed/hydrate fallback (which amplifies rate limits).
 */
export async function fetchUserPlaylistPage(
  accessToken: string,
  playlistId: string,
  options: { offset: number; limit: number }
): Promise<UserPlaylistPageResult> {
  const limit = Math.min(50, Math.max(1, Math.floor(options.limit)));
  const offset = Math.max(0, Math.floor(options.offset));

  if (offset > 0) {
    const tracksRes = await spotifyGetWith429Backoff(
      accessToken,
      buildUserPlaylistTracksUrl(playlistId, offset, limit)
    );
    if (!tracksRes.ok) {
      const t = await tracksRes.text().catch(() => "");
      if (tracksRes.status === 429) {
        throw new Error(
          `GET /v1/playlists/{id}/tracks rate-limited (429) after retries. Wait a minute and try again. ${t.slice(
            0,
            120
          )}`
        );
      }
      throw new Error(
        `GET /v1/playlists/{id}/tracks failed: ${tracksRes.status} ${t.slice(0, 200)}`
      );
    }
    const data = (await tracksRes.json()) as {
      items: Array<{ track: unknown; episode?: unknown } | null>;
      total?: number;
    };
    const rawItems = data.items ?? [];
    const itemCount = rawItems.length;
    const tracks = normalizePlaylistPageItems(rawItems);
    const total =
      typeof data.total === "number" && data.total >= 0
        ? data.total
        : offset + itemCount;
    const end = offset + itemCount;
    const nextOffset: number | null = end < total ? end : null;
    return {
      id: playlistId,
      name: "",
      coverImage: null,
      tracks,
      total,
      nextOffset,
    };
  }

  const [meta, tracksRes] = await Promise.all([
    fetchUserPlaylistMeta(accessToken, playlistId),
    spotifyGetWith429Backoff(
      accessToken,
      buildUserPlaylistTracksUrl(playlistId, 0, limit)
    ),
  ]);

  if (!tracksRes.ok) {
    const t = await tracksRes.text().catch(() => "");
    if (tracksRes.status === 429) {
      throw new Error(
        `GET /v1/playlists/{id}/tracks rate-limited (429) after retries. Wait a minute and try again. ${t.slice(
          0,
          120
        )}`
      );
    }
    if (tracksRes.status === 403 || tracksRes.status === 404) {
      console.warn(
        `[spotifyUser] playlist /tracks ${tracksRes.status}; trying full user-token fetch, then embed`
      );
      let tracks: NormalizedTrack[] = [];
      try {
        tracks = await fetchAllPlaylistTracksWithUserToken(
          accessToken,
          playlistId
        );
      } catch (e) {
        console.warn("[spotifyUser] user-token full playlist fetch failed:", e);
      }
      if (tracks.length === 0) {
        tracks = await loadTracksWhenWebApiBlocks(playlistId);
      }
      return {
        id: meta.id,
        name: meta.name,
        description: meta.description ?? undefined,
        coverImage: meta.coverImage,
        tracks,
        total: tracks.length,
        nextOffset: null,
      };
    }
    throw new Error(
      `GET /v1/playlists/{id}/tracks failed: ${tracksRes.status} ${t.slice(0, 200)}`
    );
  }

  const data = (await tracksRes.json()) as {
    items: Array<{ track: unknown; episode?: unknown } | null>;
    total?: number;
  };
  const rawItems = data.items ?? [];
  const itemCount = rawItems.length;
  const tracks = normalizePlaylistPageItems(rawItems);
  const total =
    typeof data.total === "number" && data.total >= 0
      ? data.total
      : itemCount;
  const end = itemCount;
  const nextOffset: number | null = end < total ? end : null;

  return {
    id: meta.id,
    name: meta.name,
    description: meta.description ?? undefined,
    coverImage: meta.coverImage,
    tracks,
    total,
    nextOffset,
  };
}
