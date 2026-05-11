/**
 * Thin Spotify Web API wrapper that runs on the server.
 * Uses the Client Credentials Flow so we only need SPOTIFY_CLIENT_ID /
 * SPOTIFY_CLIENT_SECRET — good enough to read public playlist metadata.
 *
 * IMPORTANT: On 2024-11-27 Spotify deprecated several Web API endpoints for
 * apps created after that date. In particular:
 *   - GET /playlists/{id}/tracks now returns 403
 *   - GET /playlists/{id} still returns 200 for playlist metadata but the
 *     response no longer contains a `tracks` field at all (even when an
 *     explicit `fields=...,tracks.items(...)` filter is supplied).
 *   - GET /tracks?ids=... (batch) also returns 403.
 * What still works for new apps:
 *   - GET /tracks/{id} (single)
 *   - GET /albums/{id}, /artists/{id}, /search, etc.
 *
 * To work around this we fetch the track list from the **public embed page**
 * (https://open.spotify.com/embed/playlist/{id}) which ships its state in a
 * `__NEXT_DATA__` JSON blob — no auth required — then hydrate per-track
 * album covers via the single-track endpoint in parallel.
 */

import type { NormalizedTrack } from "./types";
import { SVP_PLAYLIST_NOT_PUBLIC } from "./playlistLoadErrors";

type TokenCache = {
  access_token: string;
  expires_at: number; // epoch ms
};

let tokenCache: TokenCache | null = null;

export async function getSpotifyAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expires_at > now + 10_000) {
    return tokenCache.access_token;
  }

  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Fill them in .env.local."
    );
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to fetch Spotify access token (${res.status}): ${detail}`
    );
  }

  const json = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  tokenCache = {
    access_token: json.access_token,
    expires_at: now + json.expires_in * 1000,
  };

  return tokenCache.access_token;
}

interface PlaylistMeta {
  id: string;
  name: string;
  description: string;
  coverImage: string | null;
}

interface EmbedTrackListItem {
  uri: string;
  title: string;
  subtitle: string;
  audioPreview?: { url?: string } | null;
  /**
   * Per-track album cover as served by the public embed page. This is the
   * track's *own* artwork (sourced from `visualIdentity.image[].url` in the
   * embed's `__NEXT_DATA__`) — it is NOT the playlist cover. It's kept as a
   * track-level alternate source for hydration in case the single-track
   * Web API call fails (rate limit, transient error, etc.).
   */
  embedCover?: string | null;
}

/** Shape of a single image entry inside the embed page's trackList items. */
interface EmbedImageEntry {
  url?: string;
  maxWidth?: number;
  maxHeight?: number;
}

interface SpotifyTrackResponse {
  id: string;
  name: string;
  preview_url: string | null;
  external_urls?: { spotify?: string };
  album?: {
    images?: { url: string; width: number | null; height: number | null }[];
  };
  artists?: { name: string }[];
}

/**
 * Coarse lifecycle events emitted by the long-running `fetchPlaylist`
 * call. Consumed by the streaming route so the client can render a
 * "fetching N/total" progress bar without waiting for the full
 * hydration to complete.
 */
export type FetchPlaylistProgress =
  | { phase: "meta"; total: number; name: string; coverImage: string | null }
  | { phase: "track"; done: number; total: number };

export interface FetchPlaylistOptions {
  onProgress?: (evt: FetchPlaylistProgress) => void;
  /**
   * Preview (non-login) fast path. Skips per-track `GET /v1/tracks/{id}`
   * hydration entirely and builds `NormalizedTrack[]` directly from the
   * playlist/embed payload rows (`title`, `subtitle`, `audioPreview`,
   * per-track `embedCover`). Public playlists only.
   *
   * Tradeoffs vs. full hydrate (used when omitted / `false`):
   *  - Much faster (one playlist fetch vs. N single-track fetches).
   *  - No 429 amplification from bursts of `/v1/tracks/{id}` calls.
   *  - Slightly less canonical metadata (artist string from embed
   *    `subtitle`, no oEmbed cover repair) and `preview_url` is whatever
   *    the embed/list endpoint reports.
   */
  previewEmbedOnly?: boolean;
  /**
   * When set with {@link previewEmbedOnly}: load **only** from
   * `open.spotify.com/embed/playlist/{id}` (single scrape for metadata +
   * track list). Skips `GET /v1/playlists/{id}` and Web API
   * `.../tracks` paging — avoids user-token / client-credentials playlist
   * traffic and rate limits on large queues. Only works for **public**
   * embed-visible playlists.
   */
  tracksFromEmbedOnly?: boolean;
}

export async function fetchPlaylist(
  playlistId: string,
  opts: FetchPlaylistOptions = {}
): Promise<{
  id: string;
  name: string;
  description: string;
  coverImage: string | null;
  tracks: NormalizedTrack[];
}> {
  let meta: PlaylistMeta;
  let embedTracks: EmbedTrackListItem[];

  if (opts.tracksFromEmbedOnly) {
    if (!opts.previewEmbedOnly) {
      throw new Error(
        "tracksFromEmbedOnly requires previewEmbedOnly (oEmbed cover path)"
      );
    }
    const snapshot = await fetchPlaylistSnapshotFromEmbed(playlistId);
    meta = {
      id: snapshot.id,
      name: snapshot.name,
      description: snapshot.description,
      coverImage: snapshot.coverImage,
    };
    embedTracks = snapshot.tracks;
  } else {
    // 1. Playlist metadata (client credentials — no user token).
    meta = await fetchPlaylistMeta(playlistId);

    // 2. Try the Web API playlist-tracks endpoint first (works for legacy apps).
    //    If it's blocked (403) for this app, fall back to the public embed page.
    embedTracks =
      (await fetchPlaylistTracksViaWebApi(playlistId)) ??
      (await fetchPlaylistTracksViaEmbed(playlistId));
  }

  // Emit a `meta` progress event now that we know the total track
  // count — this is what the landing progress bar uses to render
  // "fetching 0/1250" immediately after the user submits.
  opts.onProgress?.({
    phase: "meta",
    total: embedTracks.length,
    name: meta.name,
    coverImage: meta.coverImage,
  });

  // 3a. Preview fast path — skip the authenticated `GET /v1/tracks/{id}`
  //     hydration but still resolve per-track album covers via the public,
  //     unauthenticated oEmbed endpoint. The 2024-11+ Spotify embed
  //     `__NEXT_DATA__` no longer carries per-track `visualIdentity.image`
  //     in `trackList`, so without this step every preview track would land
  //     with `albumCover: ""` — breaking the orbit atlas (no entries → no
  //     GPU pick → clicks dead) and the elastic grid (all tiles fall back
  //     to the missing-cover placeholder).
  if (opts.previewEmbedOnly) {
    const tracks = await hydrateCoversViaOEmbed(embedTracks, opts.onProgress);
    return { ...meta, tracks };
  }

  // 3b. Hydrate per-track details (album cover, artists, external url) by
  //    calling the single-track endpoint in parallel with a small concurrency
  //    cap — the batch /tracks?ids= endpoint is blocked for new apps. The
  //    playlist cover is intentionally NOT passed in: each normalized track
  //    must carry its own album artwork or nothing at all.
  const tracks = await hydrateTracks(embedTracks, opts.onProgress);

  return { ...meta, tracks };
}

/**
 * Preview fast path: build `NormalizedTrack[]` from playlist/embed rows
 * and resolve each track's album cover via the public oEmbed endpoint
 * (`open.spotify.com/oembed?url=spotify:track:{id}`) — no auth, no
 * `/v1/tracks/{id}` calls.
 *
 * Why this exists separately from {@link hydrateTracks}: as of 2024-11 the
 * embed-page `__NEXT_DATA__` trackList no longer ships per-track
 * `visualIdentity.image[]`, so {@link fetchPlaylistTracksViaEmbed} returns
 * rows with `embedCover: null` for every track. Without an explicit cover
 * hydration the orbit visualizer's atlas builder (which filters for
 * `albumCover.length > 0`) ends up with **zero** entries — `uAtlas.value`
 * stays `null`, `Planes.pick()` short-circuits, and orbit clicks become
 * dead. Elastic still "works" because it picks via DOM `data-track-id`,
 * but every tile collapses to the placeholder SVG.
 *
 * Concurrency 8 keeps total latency reasonable (~300ms × ceil(N/8)) while
 * staying well below Spotify's oEmbed throttle. Rows that already carry an
 * `embedCover` (legacy / Web-API path) skip the network round-trip.
 */
async function hydrateCoversViaOEmbed(
  embedTracks: EmbedTrackListItem[],
  onProgress?: (evt: FetchPlaylistProgress) => void
): Promise<NormalizedTrack[]> {
  const total = embedTracks.length;
  if (total === 0) return [];

  const concurrency = 8;
  const out: (NormalizedTrack | null)[] = new Array(total).fill(null);
  let completed = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < total) {
      const idx = cursor++;
      const embed = embedTracks[idx]!;
      const id = embed.uri?.split(":").pop() ?? "";
      if (!id) {
        completed++;
        onProgress?.({ phase: "track", done: completed, total });
        continue;
      }

      let cover: string | null = embed.embedCover ?? null;
      if (!cover) {
        cover = await fetchTrackCoverViaOEmbed(id);
      }

      out[idx] = {
        id,
        title: embed.title ?? "",
        artist: embed.subtitle ?? "",
        albumCover: cover ?? "",
        spotifyUrl: `https://open.spotify.com/track/${id}`,
        previewUrl: embed.audioPreview?.url ?? null,
      };
      completed++;
      onProgress?.({ phase: "track", done: completed, total });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out.filter((t): t is NormalizedTrack => Boolean(t?.id));
}

/**
 * Fetches a playlist’s tracks via the same Web-API + embed + hydration path as
 * {@link fetchPlaylist}, but does **not** call `GET /playlists/{id}` for metadata
 * (client-credentials cannot see the user’s private lists — that 404s and
 * aborts the pipeline before the embed runs). Callers with a user access token
 * should use this for track bodies when they already have metadata from `/v1/me`
 * or `GET /v1/playlists/{id}` with the user’s bearer token.
 */
export async function fetchPlaylistTracksOnly(
  playlistId: string,
  opts: FetchPlaylistOptions = {}
): Promise<NormalizedTrack[]> {
  let embedTracks = await fetchPlaylistTracksViaWebApi(playlistId);
  if (!embedTracks) {
    embedTracks = await fetchPlaylistTracksViaEmbed(playlistId);
  }
  opts.onProgress?.({
    phase: "meta",
    total: embedTracks.length,
    name: "",
    coverImage: null,
  });
  return hydrateTracks(embedTracks, opts.onProgress);
}

async function fetchPlaylistMeta(playlistId: string): Promise<PlaylistMeta> {
  const token = await getSpotifyAccessToken();
  const fields = encodeURIComponent("id,name,description,images");
  const res = await fetch(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(
      playlistId
    )}?fields=${fields}`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Spotify API error (${res.status}) for playlist ${playlistId}: ${detail}`
    );
  }
  const data = (await res.json()) as {
    id: string;
    name: string;
    description: string | null;
    images: { url: string }[];
  };
  return {
    id: data.id,
    name: data.name,
    description: data.description ?? "",
    coverImage: data.images?.[0]?.url ?? null,
  };
}

/**
 * Attempt to read the track list via the Web API. Returns `null` when the
 * endpoint is blocked for this app (common for apps created after
 * 2024-11-27) so the caller can fall back to the embed-page scrape.
 *
 * Pagination: Spotify caps responses at 100 items per request. We page
 * explicitly with `limit=100&offset=…` (rather than following
 * `data.next`) so the behavior is obvious and independent of any
 * future change Spotify makes to `next` — we keep asking for the next
 * 100-item slice until either:
 *
 *   1. a page comes back with fewer than 100 items (that's the last
 *      page — Spotify returned everything it has), or
 *   2. we've retrieved `total` items (short-circuit once we've seen
 *      the full list), or
 *   3. we hit an absurd safety cap (100 pages × 100 = 10 000 tracks).
 *
 * If a later page fails mid-walk, we return what we already have
 * rather than discarding the partial list — better a few hundred
 * tracks than nothing.
 */
async function fetchPlaylistTracksViaWebApi(
  playlistId: string
): Promise<EmbedTrackListItem[] | null> {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 100; // 10k-track safety ceiling.
  const token = await getSpotifyAccessToken().catch(() => null);
  if (!token) return null;

  const all: EmbedTrackListItem[] = [];
  // Use the Web API's `fields` filter to keep each page small.
  const fields = encodeURIComponent(
    "items(track(id,uri,name,preview_url,artists(name),album(images))),next,total"
  );

  let offset = 0;
  let total: number | null = null;
  let firstPage = true;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.spotify.com/v1/playlists/${encodeURIComponent(
      playlistId
    )}/tracks?limit=${PAGE_SIZE}&offset=${offset}&fields=${fields}`;

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
    } catch (err) {
      console.warn(`[spotify] playlist tracks page fetch error:`, err);
      break;
    }

    if (!res.ok) {
      // First-page failure means this app's tier can't read the
      // endpoint at all → signal to the caller to fall back to the
      // embed scrape. Later-page failure just truncates the list.
      if (firstPage) return null;
      console.warn(
        `[spotify] playlist tracks page ${page} returned ${res.status}; keeping ${all.length} items fetched so far`
      );
      break;
    }
    firstPage = false;

    const data = (await res.json()) as {
      items: Array<{
        track: {
          uri?: string;
          id?: string;
          name?: string;
          artists?: { name: string }[];
          preview_url?: string | null;
          album?: { images?: { url: string }[] };
        } | null;
      }>;
      next: string | null;
      total?: number;
    };

    const items = data.items ?? [];
    if (typeof data.total === "number") total = data.total;

    for (const item of items) {
      const t = item?.track;
      if (!t || !t.id || !t.uri) continue;
      all.push({
        uri: t.uri,
        title: t.name ?? "",
        subtitle: t.artists?.map((a) => a.name).join(", ") ?? "",
        audioPreview: t.preview_url ? { url: t.preview_url } : null,
        // Album artwork as returned by the playlist endpoint (per-track,
        // not the playlist cover). Used as a hydration fallback only.
        embedCover: t.album?.images?.[0]?.url ?? null,
      });
    }

    // Stop conditions: a short page (Spotify gave us everything it has)
    // or we've already collected every track according to `total`.
    if (items.length < PAGE_SIZE) break;
    if (total !== null && all.length >= total) break;

    offset += PAGE_SIZE;
  }

  return all;
}

type EmbedPlaylistEntity = {
  id?: string;
  name?: string;
  title?: string;
  subtitle?: string;
  coverArt?: {
    sources?: { url?: string; width?: number | null; height?: number | null }[];
  };
  visualIdentity?: { image?: EmbedImageEntry[] };
  trackList?: Array<
    EmbedTrackListItem & { visualIdentity?: { image?: EmbedImageEntry[] } }
  >;
};

function pickPlaylistCoverFromEmbedEntity(
  e: EmbedPlaylistEntity | undefined
): string | null {
  if (!e) return null;
  const sources = e.coverArt?.sources?.filter(
    (s): s is { url: string; width?: number | null } => Boolean(s?.url)
  );
  if (sources?.length) {
    return sources.reduce((best, cur) =>
      (cur.width ?? 0) > (best.width ?? 0) ? cur : best
    ).url;
  }
  const imgs = e.visualIdentity?.image ?? [];
  if (!imgs.length) return null;
  const largest = imgs.reduce<EmbedImageEntry | null>((best, cur) => {
    if (!cur?.url) return best;
    if (!best) return cur;
    return (cur.maxWidth ?? 0) > (best.maxWidth ?? 0) ? cur : best;
  }, null);
  return largest?.url ?? null;
}

type EmbedPlaylistSnapshot = {
  id: string;
  name: string;
  description: string;
  coverImage: string | null;
  tracks: EmbedTrackListItem[];
};

function parseEmbedPlaylistHtml(
  html: string,
  playlistIdFallback: string
): EmbedPlaylistSnapshot | null {
  const marker = html.indexOf("__NEXT_DATA__");
  if (marker === -1) return null;

  const scriptStart = html.indexOf(">", marker) + 1;
  const scriptEnd = html.indexOf("</script>", scriptStart);
  if (scriptStart === 0 || scriptEnd === -1) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(html.slice(scriptStart, scriptEnd));
  } catch {
    return null;
  }

  const entity = (parsed as {
    props?: {
      pageProps?: {
        state?: {
          data?: {
            entity?: EmbedPlaylistEntity;
          };
        };
      };
    };
  })?.props?.pageProps?.state?.data?.entity;

  if (!entity) return null;

  const list = entity.trackList;
  const tracks: EmbedTrackListItem[] = Array.isArray(list)
    ? list
        .filter((t) => Boolean(t?.uri && t.uri.startsWith("spotify:track:")))
        .map((t) => {
          const images = t.visualIdentity?.image ?? [];
          const largest = images.reduce<EmbedImageEntry | null>(
            (best, cur) => {
              if (!cur?.url) return best;
              if (!best) return cur;
              return (cur.maxWidth ?? 0) > (best.maxWidth ?? 0) ? cur : best;
            },
            null
          );
          return {
            uri: t.uri,
            title: t.title,
            subtitle: t.subtitle,
            audioPreview: t.audioPreview ?? null,
            embedCover: largest?.url ?? null,
          };
        })
    : [];

  const id = entity.id ?? playlistIdFallback;
  const name =
    (entity.name ?? entity.title ?? "Playlist").trim() || "Playlist";
  const description = (entity.subtitle ?? "").trim();

  return {
    id,
    name,
    description,
    coverImage: pickPlaylistCoverFromEmbedEntity(entity),
    tracks,
  };
}

async function fetchEmbedPlaylistHtml(playlistId: string): Promise<Response> {
  return fetch(
    `https://open.spotify.com/embed/playlist/${encodeURIComponent(playlistId)}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      cache: "no-store",
    }
  );
}

async function fetchPlaylistSnapshotFromEmbed(
  playlistId: string
): Promise<EmbedPlaylistSnapshot> {
  const res = await fetchEmbedPlaylistHtml(playlistId);
  if (!res.ok) {
    throw new Error(SVP_PLAYLIST_NOT_PUBLIC);
  }
  const html = await res.text();
  const snap = parseEmbedPlaylistHtml(html, playlistId);
  if (!snap || snap.tracks.length === 0) {
    throw new Error(SVP_PLAYLIST_NOT_PUBLIC);
  }
  return snap;
}

/**
 * Fallback: scrape the public embed page's `__NEXT_DATA__` blob for the
 * full track list. Requires no auth and returns the tracks that would
 * otherwise be blocked by the Web API tier.
 */
async function fetchPlaylistTracksViaEmbed(
  playlistId: string
): Promise<EmbedTrackListItem[]> {
  const res = await fetchEmbedPlaylistHtml(playlistId);
  if (!res.ok) {
    throw new Error(
      `Could not load playlist embed page (${res.status}). Make sure the playlist is public.`
    );
  }

  const html = await res.text();
  const snap = parseEmbedPlaylistHtml(html, playlistId);
  return snap?.tracks ?? [];
}

/**
 * Hydrate each track via `GET /v1/tracks/{id}` in parallel.
 *
 * Album artwork is resolved in this strict order (all per-track sources —
 * the playlist cover is NEVER used as a fallback):
 *
 *   1. Web API `track.album.images[0].url` (richest — 640×640).
 *   2. The track's own image from the Web API playlist endpoint, if we
 *      already captured it during `fetchPlaylistTracksViaWebApi`.
 *   3. Public oEmbed `thumbnail_url` (300×300, up-scaled to 640×640 by
 *      rewriting the Spotify CDN size prefix). Works with no auth and
 *      returns the track's *own* album art, so it stays correct even
 *      when the Web API rate-limits us (HTTP 429).
 *   4. Empty string — paired with a `console.warn` so the failure is
 *      never silently masked by substituting a playlist image.
 */
async function hydrateTracks(
  embedTracks: EmbedTrackListItem[],
  onProgress?: (evt: FetchPlaylistProgress) => void
): Promise<NormalizedTrack[]> {
  if (embedTracks.length === 0) return [];
  const token = await getSpotifyAccessToken();

  /** Low default — parallel GET /v1/tracks/{id} bursts often hit 429. */
  const concurrency = 2;
  const out: (NormalizedTrack | null)[] = new Array(embedTracks.length).fill(null);

  // Completed track counter shared across workers. We emit a progress
  // event after each track resolves (success or failure) so the UI can
  // paint a smooth "N / total" progress bar. Using a plain closure
  // variable is safe because JS is single-threaded — workers only race
  // on `await` boundaries.
  let completed = 0;
  const total = embedTracks.length;

  let cursor = 0;
  async function worker() {
    while (cursor < total) {
      const idx = cursor++;
      const embed = embedTracks[idx];
      const id = embed.uri.split(":").pop();
      if (!id) {
        completed++;
        onProgress?.({ phase: "track", done: completed, total });
        continue;
      }

      const detail = await fetchTrackDetail(id, token);
      // Space out requests even across workers to reduce 429s from Spotify.
      await new Promise((r) => setTimeout(r, 50));
      const apiImage = detail?.album?.images?.[0]?.url ?? null;

      let image: string | null = apiImage ?? embed.embedCover ?? null;

      // Public per-track oEmbed fallback. Only invoked when the Web API
      // call failed/returned no image — i.e. when the old code would
      // have silently substituted the playlist cover.
      if (!image) {
        image = await fetchTrackCoverViaOEmbed(id);
        if (image) {
          console.warn(
            `[spotify] track ${id} hydration fell back to oEmbed cover`
          );
        }
      }

      if (!image) {
        console.warn(
          `[spotify] track ${id} hydration produced no album cover`
        );
      }

      out[idx] = {
        id,
        title: detail?.name ?? embed.title ?? "",
        artist:
          detail?.artists?.map((a) => a.name).join(", ") ??
          embed.subtitle ??
          "",
        albumCover: image ?? "",
        spotifyUrl:
          detail?.external_urls?.spotify ??
          `https://open.spotify.com/track/${id}`,
        previewUrl:
          detail?.preview_url ?? embed.audioPreview?.url ?? null,
      };

      completed++;
      onProgress?.({ phase: "track", done: completed, total });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out.filter((t): t is NormalizedTrack => Boolean(t?.id));
}

/**
 * Run the same per-track hydration as playlist embed loading (`GET /v1/tracks/{id}`,
 * oEmbed fallbacks) on tracks built from other endpoints (e.g. `/v1/me/tracks`).
 * Keeps home visualizer album art and titles aligned with the playlist pipeline.
 */
export async function hydrateNormalizedTracks(
  tracks: NormalizedTrack[]
): Promise<NormalizedTrack[]> {
  if (tracks.length === 0) return [];
  const embedTracks: EmbedTrackListItem[] = tracks.map((t) => ({
    uri: `spotify:track:${t.id}`,
    title: t.title,
    subtitle: t.artist,
    audioPreview: t.previewUrl ? { url: t.previewUrl } : null,
    embedCover: t.albumCover || null,
  }));
  return hydrateTracks(embedTracks);
}

/**
 * No-auth track cover lookup via Spotify's public oEmbed endpoint.
 * Returns the track's album cover URL (up-scaled to 640×640 by rewriting
 * the Spotify CDN size prefix) or `null` on failure.
 *
 * The thumbnail URLs Spotify serves follow the shape
 *   https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02{hash}
 * where `00001e02` is the 300×300 variant. `0000b273` is the 640×640
 * variant — the same one `/v1/tracks/{id}` returns as `album.images[0]`.
 */
async function fetchTrackCoverViaOEmbed(id: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://open.spotify.com/oembed?url=spotify:track:${encodeURIComponent(id)}`,
      { cache: "no-store" }
    );
    if (!r.ok) {
      console.warn(`[spotify] oEmbed cover failed for ${id}: ${r.status}`);
      return null;
    }
    const j = (await r.json()) as { thumbnail_url?: string };
    const thumb = j.thumbnail_url;
    if (!thumb) return null;
    return thumb.replace(/\/ab67616d00001e02/, "/ab67616d0000b273");
  } catch (err) {
    console.warn(`[spotify] oEmbed cover error for ${id}:`, err);
    return null;
  }
}

/**
 * Single-track fetch with one automatic retry when Spotify rate-limits us
 * (HTTP 429). Returns `null` on any failure — callers must treat a null as
 * a hydration failure (logged) rather than substituting a different image.
 */
async function fetchTrackDetail(
  id: string,
  token: string
): Promise<SpotifyTrackResponse | null> {
  const url = `https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });

      if (r.ok) return (await r.json()) as SpotifyTrackResponse;

      if (r.status === 429 && attempt === 0) {
        const retryAfter = Number(r.headers.get("retry-after") ?? "1");
        const waitMs = Math.min(5000, Math.max(500, retryAfter * 1000));
        console.warn(
          `[spotify] 429 rate-limit on track ${id}; retrying in ${waitMs}ms`
        );
        await new Promise((res) => setTimeout(res, waitMs));
        continue;
      }

      const detail = await r.text().catch(() => "");
      console.warn(
        `[spotify] track hydration failed for ${id}: ${r.status} ${detail.slice(
          0,
          200
        )}`
      );
      return null;
    } catch (err) {
      console.warn(`[spotify] track hydration error for ${id}:`, err);
      return null;
    }
  }
  return null;
}
