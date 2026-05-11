export interface NormalizedTrack {
  id: string;
  title: string;
  artist: string;
  albumCover: string;
  spotifyUrl: string;
  previewUrl: string | null;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverImage?: string | null;
  tracks: NormalizedTrack[];
}

export type VisualMode = "default" | "track";

/** Main gallery experience: WebGL orbit vs Codrops elastic grid. */
export type GalleryVisualStyle = "orbit" | "elastic_lag";

/** Raw-ish shape of the Spotify playlist endpoint we care about. */
export interface SpotifyPlaylistResponse {
  id: string;
  name: string;
  description: string | null;
  images: { url: string; width: number | null; height: number | null }[];
  tracks: {
    items: Array<{
      track: {
        id: string;
        name: string;
        preview_url: string | null;
        external_urls: { spotify?: string };
        album: {
          images: { url: string; width: number | null; height: number | null }[];
        };
        artists: { name: string }[];
      } | null;
    }>;
  };
}
