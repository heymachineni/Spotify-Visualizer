import { NextResponse } from "next/server";
import { getRequestCookie } from "@/lib/server/requestCookies";
import {
  buildRecentPlaylist,
  fetchAllUserPlaylists,
  fetchRecentTracks,
  fetchSavedTracksPage,
  fetchUserProfile,
} from "@/lib/spotifyUserApi";
import type { UserLibraryResponse } from "@/lib/userLibraryTypes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SPOTIFY_SAVED_MAX = 50;

/**
 * - `?type=liked&limit&offset` — one Spotify page of saved tracks: `{ tracks, total, nextOffset }`.
 * - `?mode=summary` — profile + playlist list.
 * - `?mode=rest` — recently played only; liked is loaded client-side via `type=liked`.
 * - `?mode=full` — all sections; liked is still not bulk-fetched (use `type=liked`).
 */
export async function GET(request: Request) {
  const token = getRequestCookie(request, "svp_access_token");
  if (!token) {
    return NextResponse.json({ error: "not_logged_in" }, { status: 401 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get("type");

  if (type === "liked") {
    const limit = Math.min(
      SPOTIFY_SAVED_MAX,
      Math.max(1, parseInt(url.searchParams.get("limit") || "50", 10) || 50)
    );
    const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    try {
      const page = await fetchSavedTracksPage(token, { limit, offset });
      return NextResponse.json(page);
    } catch (err) {
      console.error("[user/library] type=liked failed:", err);
      const msg = err instanceof Error ? err.message : "liked_fetch_failed";
      return NextResponse.json({ error: msg }, { status: 502 });
    }
  }

  const mode = url.searchParams.get("mode") ?? "full";

  if (mode === "summary") {
    const out: UserLibraryResponse = {
      profile: null,
      playlists: [],
      liked: null,
      recent: null,
    };
    const [profileR, plR] = await Promise.allSettled([
      fetchUserProfile(token),
      fetchAllUserPlaylists(token),
    ]);
    if (profileR.status === "fulfilled") {
      out.profile = profileR.value;
    } else {
      console.error("[user/library] profile failed:", profileR.reason);
    }
    if (plR.status === "fulfilled") {
      out.playlists = plR.value;
    } else {
      console.error("[user/library] playlists failed:", plR.reason);
    }
    return NextResponse.json(out);
  }

  if (mode === "rest") {
    const out: UserLibraryResponse = {
      profile: null,
      playlists: [],
      liked: null,
      recent: null,
    };
    try {
      out.recent = buildRecentPlaylist(await fetchRecentTracks(token));
    } catch (e) {
      console.error("[user/library] recent failed:", e);
    }
    return NextResponse.json(out);
  }

  const out: UserLibraryResponse = {
    profile: null,
    playlists: [],
    liked: null,
    recent: null,
  };

  const [profileR, plR, recentR] = await Promise.allSettled([
    fetchUserProfile(token),
    fetchAllUserPlaylists(token),
    fetchRecentTracks(token),
  ]);

  if (profileR.status === "fulfilled") {
    out.profile = profileR.value;
  } else {
    console.error("[user/library] profile failed:", profileR.reason);
  }

  if (plR.status === "fulfilled") {
    out.playlists = plR.value;
  } else {
    console.error("[user/library] playlists failed:", plR.reason);
  }

  if (recentR.status === "fulfilled") {
    out.recent = buildRecentPlaylist(recentR.value);
  } else {
    console.error("[user/library] recent failed:", recentR.reason);
  }

  return NextResponse.json(out);
}
