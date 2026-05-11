/**
 * Prebake the landing-page background playlists.
 *
 * Hits Spotify once per default playlist, keeps only the first 60
 * hydrated tracks (title, artist, album cover, etc.), and writes the
 * result to `src/data/landingBackgrounds.json`. That file is imported
 * directly by the client, so the homepage can paint drifting album
 * covers immediately — no network round-trip, no progress bar, no
 * silent failure when Spotify rate-limits the anon embed endpoint on
 * first visit.
 *
 * Run it via:
 *
 *   npx tsx scripts/prebake-landing.ts
 *
 * Requires the usual `.env.local` credentials (SPOTIFY_CLIENT_ID,
 * SPOTIFY_CLIENT_SECRET). Re-run whenever the default pool changes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { extractPlaylistId } from "../src/lib/extractPlaylistId";
import { fetchPlaylist } from "../src/lib/spotify";
import { DEFAULT_PLAYLIST_POOL } from "../src/lib/defaultPlaylists";
import type { Playlist } from "../src/lib/types";

const MAX_TRACKS_PER_PLAYLIST = 60;
const OUT_FILE = path.join(
  process.cwd(),
  "src",
  "data",
  "landingBackgrounds.json"
);

async function loadEnv(): Promise<void> {
  // Minimal .env.local loader so this script doesn't pull in `dotenv`.
  // Missing file is fine — the user may have the env exported already.
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), ".env.local"),
      "utf8"
    );
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    /* no env file — skip */
  }
}

async function prebake(): Promise<void> {
  await loadEnv();

  if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error(
      "SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET must be set in .env.local before running the prebake."
    );
  }

  const pool = DEFAULT_PLAYLIST_POOL;
  const results: Playlist[] = [];

  for (const entry of pool) {
    const id = extractPlaylistId(entry);
    if (!id) {
      console.warn(`[prebake] skipping unparseable entry: ${entry}`);
      continue;
    }

    try {
      console.log(`[prebake] fetching ${id}…`);
      const playlist = await fetchPlaylist(id);
      // Cap to the first N tracks — the landing visualizer only needs
      // a handful of drifting covers and we want the prebake file to
      // stay small (~a few KB per playlist).
      const tracks = playlist.tracks
        .filter((t) => t.albumCover)
        .slice(0, MAX_TRACKS_PER_PLAYLIST);

      if (tracks.length === 0) {
        console.warn(
          `[prebake] ${id} yielded no tracks with album art; skipping`
        );
        continue;
      }

      results.push({
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        coverImage: playlist.coverImage,
        tracks,
      });

      console.log(
        `[prebake]   ✓ "${playlist.name}" — kept ${tracks.length} tracks`
      );
    } catch (err) {
      console.warn(`[prebake] failed to fetch ${id}:`, err);
    }
  }

  if (results.length === 0) {
    throw new Error(
      "[prebake] no playlists were successfully fetched — refusing to overwrite the snapshot."
    );
  }

  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    maxTracksPerPlaylist: MAX_TRACKS_PER_PLAYLIST,
    playlists: results,
  };
  await fs.writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + "\n", "utf8");

  const totalTracks = results.reduce((a, p) => a + p.tracks.length, 0);
  console.log(
    `[prebake] wrote ${results.length} playlists (${totalTracks} tracks) → ${path.relative(
      process.cwd(),
      OUT_FILE
    )}`
  );
}

prebake().catch((err) => {
  console.error(err);
  process.exit(1);
});
