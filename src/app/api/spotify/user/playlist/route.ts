import { NextResponse } from "next/server";
import { getRequestCookie } from "@/lib/server/requestCookies";
import {
  cacheKeyForRequest,
  getCachedPlaylist,
  setCachedPlaylist,
} from "@/lib/server/playlistCache";
import { fetchUserPlaylistPage } from "@/lib/spotifyUserApi";
import { SVP_PLAYLIST_LIKED_ID, SVP_PLAYLIST_RECENT_ID } from "@/lib/spotifyUserIds";
import type { UserPlaylistPageResponse } from "@/lib/userLibraryTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPOTIFY_USER_PL_MAX = 50;

function sliceFromCache(
  id: string,
  offset: number,
  limit: number,
  pl: { id: string; name: string; description?: string; coverImage?: string | null; tracks: unknown[] }
): UserPlaylistPageResponse {
  const total = pl.tracks.length;
  const tracks = pl.tracks.slice(offset, offset + limit);
  const end = offset + tracks.length;
  return {
    id: pl.id,
    name: pl.name,
    description: pl.description,
    coverImage: pl.coverImage ?? null,
    tracks: tracks as UserPlaylistPageResponse["tracks"],
    total,
    nextOffset: end < total ? end : null,
  };
}

export async function GET(request: Request) {
  const token = getRequestCookie(request, "svp_access_token");
  if (!token) {
    return NextResponse.json({ error: "not_logged_in" }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  if (id === SVP_PLAYLIST_LIKED_ID || id === SVP_PLAYLIST_RECENT_ID) {
    return NextResponse.json(
      { error: "use_library_payload_for_virtual_playlists" },
      { status: 400 }
    );
  }

  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const limit = Math.min(
    SPOTIFY_USER_PL_MAX,
    Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50)
  );

  const userKey = cacheKeyForRequest(token);
  const cached = getCachedPlaylist(userKey, id);
  if (cached && offset < cached.tracks.length) {
    return NextResponse.json(sliceFromCache(id, offset, limit, cached));
  }
  if (cached && offset >= cached.tracks.length) {
    return NextResponse.json({
      id: cached.id,
      name: cached.name,
      description: cached.description,
      coverImage: cached.coverImage ?? null,
      tracks: [],
      total: cached.tracks.length,
      nextOffset: null,
    });
  }

  try {
    const result = await fetchUserPlaylistPage(token, id, { offset, limit });
    if (
      offset === 0 &&
      result.nextOffset === null
    ) {
      setCachedPlaylist(userKey, id, {
        id: result.id,
        name: result.name,
        description: result.description,
        coverImage: result.coverImage,
        tracks: result.tracks,
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("[user/playlist] load failed:", err);
    const msg = err instanceof Error ? err.message : "load_failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
