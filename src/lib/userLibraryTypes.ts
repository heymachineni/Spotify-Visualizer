import type { NormalizedTrack, Playlist } from "./types";

export type UserProfileSummary = { name: string; image: string | null };

export type UserPlaylistSummary = {
  id: string;
  name: string;
  coverImage: string | null;
};

/** `GET /api/spotify/user/library?type=liked` (one `/v1/me/tracks` page, max 50). */
export type LikedTracksPageResponse = {
  tracks: NormalizedTrack[];
  total: number;
  nextOffset: number | null;
};

/** `GET /api/spotify/user/playlist?id=&offset=&limit=` (one Spotify page, max 50). */
export type UserPlaylistPageResponse = {
  id: string;
  name: string;
  description?: string;
  coverImage: string | null;
  tracks: NormalizedTrack[];
  total: number;
  nextOffset: number | null;
};

/** `GET /api/spotify/user/library` success body (partial on partial failure). */
export type UserLibraryResponse = {
  profile: UserProfileSummary | null;
  playlists: UserPlaylistSummary[];
  liked: Playlist | null;
  recent: Playlist | null;
};
