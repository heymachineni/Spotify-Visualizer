/**
 * Slim shape from `GET /api/spotify/now-playing` for UI (via `GET /v1/me/player`).
 */
export type NowPlayingResponse =
  | { playing: false }
  | {
      playing: true;
      isPlaying: boolean;
      progressMs: number;
      durationMs: number;
      track: {
        id: string;
        title: string;
        artist: string;
        albumCover: string;
        spotifyUrl: string;
      };
    };
