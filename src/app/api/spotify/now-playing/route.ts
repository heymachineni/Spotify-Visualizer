import { NextResponse } from "next/server";
import { getRequestCookie } from "@/lib/server/requestCookies";
import type { NowPlayingResponse } from "@/lib/nowPlayingTypes";
import { pickBestAlbumImageUrl } from "@/lib/mapSpotifyWebApiTrack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `GET /v1/me/player` — requires `user-read-playback-state` (already in login scopes).
 * 204: no active playback in Spotify Connect / Web API context.
 */
export async function GET(request: Request) {
  const token = getRequestCookie(request, "svp_access_token");
  if (!token?.trim()) {
    return NextResponse.json({ error: "not_logged_in" }, { status: 401 });
  }

  const res = await fetch("https://api.spotify.com/v1/me/player", {
    headers: { Authorization: `Bearer ${token.trim()}` },
    cache: "no-store",
  });

  if (res.status === 204) {
    return NextResponse.json({ playing: false } satisfies NowPlayingResponse);
  }

  if (res.status === 401) {
    return NextResponse.json({ error: "token_expired" }, { status: 401 });
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return NextResponse.json(
      { error: "spotify_error", detail: t.slice(0, 200) },
      { status: 502 }
    );
  }

  const data = (await res.json()) as {
    is_playing?: boolean;
    progress_ms?: number;
    item?: {
      type?: string;
      id?: string;
      name?: string;
      duration_ms?: number;
      external_urls?: { spotify?: string };
      album?: { images?: { url: string; width?: number | null }[] };
      artists?: { name: string }[];
    } | null;
  };

  const item = data.item;
  if (!item || item.type !== "track" || !item.id || !item.name) {
    return NextResponse.json({ playing: false } satisfies NowPlayingResponse);
  }

  const albumCover = pickBestAlbumImageUrl(item.album?.images);
  const artist = item.artists?.map((a) => a.name).join(", ") ?? "";
  const durationMs = Math.max(0, item.duration_ms ?? 0);
  const progressMs = Math.max(
    0,
    Math.min(data.progress_ms ?? 0, durationMs || Number.MAX_SAFE_INTEGER)
  );

  const body: NowPlayingResponse = {
    playing: true,
    isPlaying: Boolean(data.is_playing),
    progressMs,
    durationMs,
    track: {
      id: item.id,
      title: item.name,
      artist,
      albumCover,
      spotifyUrl:
        item.external_urls?.spotify ?? `https://open.spotify.com/track/${item.id}`,
    },
  };

  return NextResponse.json(body);
}
