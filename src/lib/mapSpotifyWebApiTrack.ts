import type { NormalizedTrack } from "./types";

/**
 * `album.images[0]` is not always the largest — especially on `/v1/me/tracks`
 * and some playlist item shapes, Spotify may return thumbnails ascending by
 * size. Prefer max `width` when present; otherwise the last image is usually
 * the largest (and matches embed/hydration quality on the home canvas).
 */
export function pickBestAlbumImageUrl(
  images?: { url: string; width?: number | null; height?: number | null }[]
): string {
  if (!images?.length) return "";
  const withUrl = images.filter((i) => i?.url) as {
    url: string;
    width?: number | null;
    height?: number | null;
  }[];
  if (withUrl.length === 0) return "";
  if (withUrl.some((i) => i.width != null)) {
    return withUrl.reduce((best, cur) =>
      (cur.width ?? 0) > (best.width ?? 0) ? cur : best
    ).url;
  }
  return withUrl[withUrl.length - 1]!.url;
}

/** Spotify "full track" or embedded track from playlist/saved context. */
export function mapSpotifyWebApiTrack(
  t: {
    id: string;
    name: string;
    preview_url: string | null;
    external_urls?: { spotify?: string };
    album?: { images?: { url: string; width?: number | null; height?: number | null }[] };
    artists?: { name: string }[];
  } | null
): NormalizedTrack | null {
  if (!t?.id) return null;
  return {
    id: t.id,
    title: t.name,
    artist: t.artists?.map((a) => a.name).join(", ") ?? "",
    albumCover: pickBestAlbumImageUrl(t.album?.images),
    spotifyUrl: t.external_urls?.spotify ?? `https://open.spotify.com/track/${t.id}`,
    previewUrl: t.preview_url,
  };
}

type EpisodeMapInput = {
  id: string;
  name: string;
  preview_url: string | null;
  external_urls?: { spotify?: string };
  images?: { url: string; width?: number | null; height?: number | null }[];
  show?: {
    name?: string;
    images?: { url: string; width?: number | null; height?: number | null }[];
  } | null;
  artists?: { name: string }[];
};

/**
 * Episodes in playlists (and episode-shaped "track" rows when
 * `additional_types=episode` is not used) use `images` + `show`, not `album`.
 */
export function mapSpotifyWebApiEpisode(e: EpisodeMapInput | null): NormalizedTrack | null {
  if (!e?.id) return null;
  const fromShow = e.show?.name?.trim();
  const fromArtists = e.artists?.map((a) => a.name).join(", ")?.trim();
  const artist = fromShow || fromArtists || "Podcast";
  const cover =
    pickBestAlbumImageUrl(e.images) || pickBestAlbumImageUrl(e.show?.images) || "";
  return {
    id: e.id,
    title: e.name,
    artist,
    albumCover: cover,
    spotifyUrl: e.external_urls?.spotify ?? `https://open.spotify.com/episode/${e.id}`,
    previewUrl: e.preview_url,
  };
}

type PlaylistItemRow = { track?: unknown; episode?: unknown } | null;

/**
 * `GET /playlists/{id}/tracks?additional_types=track,episode` — each item may
 * be a music `track`, a top-level `episode`, or an `episode` stuffed into
 * `track` (with `type: "episode"`) for backwards compatibility.
 */
export function mapSpotifyPlaylistItemToNormalized(
  item: PlaylistItemRow
): NormalizedTrack | null {
  if (!item) return null;
  if (item.episode && typeof item.episode === "object" && item.episode !== null) {
    return mapSpotifyWebApiEpisode(item.episode as EpisodeMapInput);
  }
  if (!item.track || typeof item.track !== "object" || item.track === null) {
    return null;
  }
  const t = item.track as { type?: string };
  if (t.type === "episode") {
    return mapSpotifyWebApiEpisode(item.track as EpisodeMapInput);
  }
  return mapSpotifyWebApiTrack(
    item.track as Parameters<typeof mapSpotifyWebApiTrack>[0]
  );
}
