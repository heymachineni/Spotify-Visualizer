"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type {
  GalleryVisualStyle,
  NormalizedTrack,
  Playlist,
  VisualMode,
} from "@/lib/types";
import { useSpotifyPlaylist } from "@/hooks/useSpotifyPlaylist";
import { pickRandomLandingPlaylist } from "@/lib/defaultPlaylists";

import SpotifyVisualizer from "@/components/visualizer/SpotifyVisualizer";
import ElasticGridVisualizer from "@/components/visualizer/ElasticGridVisualizer";
import PlaygroundDock from "@/components/overlay/PlaygroundDock";
import TrackDistortion from "@/components/effects/TrackDistortion";
import SpotifyEmbedPlayer, {
  type SpotifyEmbedPlayerHandle,
} from "@/components/player/SpotifyEmbedPlayer";

import { buildLikedPlaylist, dedupeTracksFirstWins } from "@/lib/spotifyUserApi";
import { SVP_PLAYLIST_LIKED_ID } from "@/lib/spotifyUserIds";
import type {
  LikedTracksPageResponse,
  UserLibraryResponse,
  UserPlaylistPageResponse,
} from "@/lib/userLibraryTypes";
import InstructionCard from "@/components/overlay/InstructionCard";
import LandingOverlay from "@/components/landing/LandingOverlay";

import { usePlaybackManager } from "@/hooks/usePlaybackManager";
import { useDebouncedValueWhen } from "@/hooks/useDebouncedValueWhen";
import {
  type PlayPlaylistContext,
  type SdkPlaybackState,
  type UserProductType,
} from "@/components/player/PlaybackManager";
import { InAppNowPlayingPill } from "@/components/overlay/NowPlayingPill";

export default function HomePage() {
  const { loading, error, progress, fetchPlaylist } = useSpotifyPlaylist();

  // Playlists visible to the user (shown in the ControlCard dropdown).
  // The ambient "background" playlist picked for the landing overlay is
  // tracked separately in `backgroundPlaylist` and intentionally not
  // mixed in until the user explicitly enters through preview mode.
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  // Seed directly from the prebaked snapshot so the first paint
  // already has album art to feed to the visualizer. No network,
  // no spinner, no cold-start flash of an empty scene. The pick is
  // frozen per page load — `useState` initializer runs once and the
  // setter is intentionally not exposed.
  const [backgroundPlaylist] = useState<Playlist | null>(() =>
    pickRandomLandingPlaylist()
  );

  const [activeTrack, setActiveTrack] = useState<NormalizedTrack | null>(null);
  const [visualMode, setVisualMode] = useState<VisualMode>("default");
  const [galleryStyle, setGalleryStyle] = useState<GalleryVisualStyle>("orbit");

  // Landing gate. Until `entered` flips true the landing overlay is
  // rendered on top of everything and all playground UI (ControlCard,
  // InstructionCard, etc.) is suppressed.
  const [entered, setEntered] = useState(false);

  // Product type captured from /v1/me after a successful OAuth login.
  // "unknown" covers the preview-only path (user never logged in); the
  // PlaybackManager treats everything non-premium as "use the embed
  // player", so preview mode automatically stays on the existing
  // 30-second preview engine.
  const [userProductType, setUserProductType] =
    useState<UserProductType>("unknown");
  /**
   * After OAuth, if `/v1/me` was rate-limited we still enter the app and
   * poll `/api/auth/me` until Premium vs Free is known (or attempts end).
   */
  const [mePollAfterLogin, setMePollAfterLogin] = useState(false);
  /** True after Connect Spotify succeeds (cookie set), including while /me is still resolving. */
  const [oauthSession, setOauthSession] = useState(false);

  const [userLibrary, setUserLibrary] = useState<UserLibraryResponse | null>(
    null
  );
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [fetchingSpotifyId, setFetchingSpotifyId] = useState<string | null>(
    null
  );
  const [likedTracks, setLikedTracks] = useState<NormalizedTrack[]>([]);
  const [likedNextOffset, setLikedNextOffset] = useState<number | null>(null);
  const [likedLoadingMore, setLikedLoadingMore] = useState(false);
  const likedInFlightRef = useRef<Set<number>>(new Set());
  const userPlLoadGenRef = useRef(0);
  const autoFirstPlaylistRef = useRef(false);
  /** After `/library?mode=rest` (recent) attempt — unlocks defaulting to Recently Played before liked bootstrap. */
  const [libraryRestLoaded, setLibraryRestLoaded] = useState(false);
  /** After the first liked-songs bootstrap attempt finishes (fallback default + sync). */
  const [likedInitialFetchDone, setLikedInitialFetchDone] = useState(false);

  const playerRef = useRef<SpotifyEmbedPlayerHandle | null>(null);
  const playbackManager = usePlaybackManager({
    embedRef: playerRef,
    productType: userProductType,
  });

  const [sdkPlayback, setSdkPlayback] = useState<SdkPlaybackState | null>(null);
  /** Debounce paired SDK states for Premium end-of-track auto-advance */
  const sdkPrevPlaybackRef = useRef<SdkPlaybackState | null>(null);
  const sdkQueueAdvanceLockRef = useRef(false);

  useEffect(() => {
    playbackManager.setPlaybackStateListener((s) => {
      setSdkPlayback(s);
    });
    return () => {
      playbackManager.setPlaybackStateListener(null);
    };
  }, [playbackManager]);

  const activePlaylist = useMemo(() => {
    if (activePlaylistId) {
      const user = playlists.find((p) => p.id === activePlaylistId);
      if (user) return user;
      // A row is “selected” but the queue is missing — do **not** show the
      // random `backgroundPlaylist` or it looks like the pick never applied.
      return null;
    }
    // Landing / pre-login: ambient playlist only.
    return backgroundPlaylist;
  }, [playlists, activePlaylistId, backgroundPlaylist]);

  /**
   * One row per track id for orbit/elastic + queue playback. Spotify (and our
   * own tail merges) can occasionally surface the same id twice; the elastic
   * grid used to *intentionally* repeat tiles — that is removed — so we dedupe
   * here to keep visuals, picker state, and SDK `uris` batches aligned.
   */
  const dedupedActiveTracks = useMemo(
    () => dedupeTracksFirstWins(activePlaylist?.tracks ?? []),
    [activePlaylist]
  );

  const tracksForVisualizer = dedupedActiveTracks;

  /** Premium SDK: pass playlist so Spotify can advance through batched track URIs. */
  const premiumPlaylistCtx: PlayPlaylistContext | null = useMemo(() => {
    if (!dedupedActiveTracks.length) return null;
    return { playlistTracks: dedupedActiveTracks };
  }, [dedupedActiveTracks]);
  // Background fetches add ~50 tracks at a time; each change rebuilds the WebGL
  // texture atlas and janks depth-scroll. Coalesce while more data is in flight.
  const progressiveLikedViz =
    activePlaylistId === SVP_PLAYLIST_LIKED_ID && likedNextOffset !== null;
  const visualizerTracks = useDebouncedValueWhen(
    tracksForVisualizer,
    420,
    progressiveLikedViz
  );

  const { previousTracks, upcomingTracks } = useMemo(() => {
    if (!activePlaylist || !activeTrack) {
      return { previousTracks: [], upcomingTracks: [] };
    }
    const all = dedupedActiveTracks;
    const idx = all.findIndex((t) => t.id === activeTrack.id);
    if (idx < 0) {
      const ring = all.filter((t) => t.id !== activeTrack.id);
      return { previousTracks: ring.slice().reverse(), upcomingTracks: ring };
    }
    const ring = [...all.slice(idx + 1), ...all.slice(0, idx)];
    return {
      previousTracks: ring.slice().reverse(),
      upcomingTracks: ring,
    };
  }, [activePlaylist, activeTrack, dedupedActiveTracks]);

  // No mount-time fetch is needed: the landing background playlist is
  // seeded synchronously from the prebaked snapshot (see state init
  // above). This guarantees the visualizer has drifting covers from
  // the very first paint, even when Spotify's anon endpoints are
  // rate-limiting or unreachable.

  const authLibraryFetch = useCallback(async (url: string) => {
    const once = async () => {
      let r = await fetch(url, { credentials: "include" });
      if (r.status === 401) {
        await fetch("/api/auth/token", { credentials: "include" });
        r = await fetch(url, { credentials: "include" });
      }
      return r;
    };
    try {
      return await once();
    } catch {
      // Transient dev-server / tab sleep / IPv6-vs-IPv4 hiccups surface as
      // `TypeError: Failed to fetch` with no HTTP status — one backoff retry.
      await new Promise((res) => setTimeout(res, 350));
      return await once();
    }
  }, []);

  const applyUserPlaylist = useCallback(
    (playlist: Playlist) => {
      autoFirstPlaylistRef.current = true;
      setPlaylists([{ ...playlist, id: String(playlist.id) }]);
      setActivePlaylistId(String(playlist.id));
      setActiveTrack(null);
      setVisualMode("default");
      void playbackManager.pause();
    },
    [playbackManager]
  );

  /**
   * Hard cap of the public embed-page `__NEXT_DATA__.trackList`. Spotify
   * truncates to this many regardless of any pagination param we try, so
   * we resume from this offset against the user-token API for the tail.
   */
  const EMBED_TRACK_CAP = 100;
  /** Spotify Web API hard cap on `/v1/playlists/{id}/tracks?limit=`. */
  const PLAYLIST_TAIL_PAGE = 50;

  /**
   * Walk `/api/spotify/user/playlist?offset=…` starting from `startOffset`,
   * appending each page to whichever playlist is currently first in the
   * carousel (matches `applyUserPlaylist`). Skips IDs the embed pass
   * already inserted so a slight order mismatch can't produce duplicates.
   * Bails on every page when `gen` is superseded so rapid switches
   * cancel cleanly.
   */
  const streamPlaylistTailFromUserApi = useCallback(
    async (params: {
      playlistId: string;
      startOffset: number;
      gen: number;
    }): Promise<void> => {
      const { playlistId, startOffset, gen } = params;
      let offset = startOffset;
      for (;;) {
        if (gen !== userPlLoadGenRef.current) return;
        let res: Response;
        try {
          res = await authLibraryFetch(
            `/api/spotify/user/playlist?id=${encodeURIComponent(
              playlistId
            )}&offset=${offset}&limit=${PLAYLIST_TAIL_PAGE}`
          );
        } catch (err) {
          console.warn("[page] playlist tail fetch error", err);
          return;
        }
        if (gen !== userPlLoadGenRef.current) return;
        if (!res.ok) {
          console.warn("[page] playlist tail", res.status);
          return;
        }
        const j = (await res.json()) as UserPlaylistPageResponse;
        if (gen !== userPlLoadGenRef.current) return;
        const page = j.tracks ?? [];
        if (page.length > 0) {
          setPlaylists((prev) => {
            const cur = prev[0];
            if (!cur || String(cur.id) !== String(playlistId)) return prev;
            const seen = new Set(cur.tracks.map((t) => t.id));
            const fresh = page.filter((t) => !seen.has(t.id));
            if (fresh.length === 0) return prev;
            return [{ ...cur, tracks: [...cur.tracks, ...fresh] }];
          });
        }
        if (j.nextOffset === null) return;
        offset = j.nextOffset;
        // Tiny breather between pages so the atlas/scroll don't jank.
        await new Promise((r) => setTimeout(r, 120));
      }
    },
    [authLibraryFetch]
  );

  const handleLoadPlaylist = useCallback(
    async (input: string): Promise<Playlist | null> => {
      // Public embed page only: one scrape + oEmbed covers — no Web API
      // playlist / track paging (avoids private lists and rate limits).
      const loaded = await fetchPlaylist(input, {
        previewEmbedOnly: true,
        tracksFromEmbedOnly: true,
      });
      if (!loaded) return null;
      if (userProductType === "premium") {
        applyUserPlaylist(loaded);
      } else {
        setPlaylists((prev) => {
          const exists = prev.find((p) => p.id === loaded.id);
          if (exists) return prev.map((p) => (p.id === loaded.id ? loaded : p));
          return [...prev, loaded];
        });
        setActivePlaylistId(loaded.id);
      }
      // Logged-in tail: embed caps at 100, paginate the rest with the user's
      // own bearer token. Skipped for guests (no cookie → 401).
      if (
        userProductType === "premium" &&
        loaded.tracks.length >= EMBED_TRACK_CAP
      ) {
        void streamPlaylistTailFromUserApi({
          playlistId: String(loaded.id),
          startOffset: EMBED_TRACK_CAP,
          gen: ++userPlLoadGenRef.current,
        });
      }
      return loaded;
    },
    [
      fetchPlaylist,
      userProductType,
      applyUserPlaylist,
      streamPlaylistTailFromUserApi,
    ]
  );

  const handleSelectUserPlaylist = useCallback(
    async (id: string): Promise<boolean> => {
      const gen = ++userPlLoadGenRef.current;
      setFetchingSpotifyId(id);
      try {
        const input = `https://open.spotify.com/playlist/${encodeURIComponent(
          id
        )}`;
        const loaded = await fetchPlaylist(input, {
          previewEmbedOnly: true,
          tracksFromEmbedOnly: true,
        });
        if (gen !== userPlLoadGenRef.current) return false;
        if (!loaded) return false;
        applyUserPlaylist(loaded);
        // Library rows are always logged-in (this handler is gated on
        // `/library`). Paginate the rest from the user-token API.
        if (loaded.tracks.length >= EMBED_TRACK_CAP) {
          void streamPlaylistTailFromUserApi({
            playlistId: String(loaded.id),
            startOffset: EMBED_TRACK_CAP,
            gen,
          });
        }
        return true;
      } finally {
        if (gen === userPlLoadGenRef.current) {
          setFetchingSpotifyId(null);
        }
      }
    },
    [applyUserPlaylist, fetchPlaylist, streamPlaylistTailFromUserApi]
  );

  const handleSelectTrack = useCallback(
    (track: NormalizedTrack) => {
      setActiveTrack(track);
      setVisualMode("track");
      // PlaybackManager decides SDK (premium) vs embed (everyone
      // else) per call, so the call site stays engine-agnostic.
      void playbackManager.play(
        track,
        premiumPlaylistCtx ?? undefined
      );
    },
    [playbackManager, premiumPlaylistCtx]
  );

  const handleExitTrackMode = useCallback(() => {
    setVisualMode("default");
  }, []);

  const [playbackUiBump, setPlaybackUiBump] = useState(0);

  const handlePlaybackToggle = useCallback(async () => {
    await playbackManager.togglePlay();
    if (userProductType !== "premium") {
      setPlaybackUiBump((b) => b + 1);
    }
  }, [playbackManager, userProductType]);

  const dockPlaybackPaused = useMemo(() => {
    if (userProductType === "premium") {
      if (!sdkPlayback?.trackId) return true;
      if (sdkPlayback.trackId !== activeTrack?.id) {
        return sdkPlayback.paused;
      }
      return sdkPlayback.paused;
    }
    return playbackManager.getApproxEmbedPaused();
  }, [
    userProductType,
    sdkPlayback?.trackId,
    sdkPlayback?.paused,
    activeTrack?.id,
    playbackManager,
    playbackUiBump,
  ]);

  const pausedApproxForTrackChrome = useMemo(
    () =>
      userProductType === "premium"
        ? false
        : playbackManager.getApproxEmbedPaused(),
    [userProductType, playbackManager, playbackUiBump]
  );

  const canSkipQueue = useMemo(() => {
    return dedupedActiveTracks.length > 1;
  }, [dedupedActiveTracks.length]);

  const skipQueueNext = useCallback(() => {
    if (!dedupedActiveTracks.length) return;
    const all = dedupedActiveTracks;
    const ctx: PlayPlaylistContext = { playlistTracks: all };

    if (!activeTrack?.id) {
      const pick = all[0]!;
      setActiveTrack(pick);
      void playbackManager.play(pick, ctx);
      if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
      return;
    }

    if (all.length < 2) {
      void playbackManager.play(activeTrack, ctx);
      if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
      return;
    }

    const idx = all.findIndex((t) => t.id === activeTrack.id);
    const nextIdx = idx >= 0 ? (idx + 1) % all.length : 0;
    const next = all[nextIdx]!;
    setActiveTrack(next);
    void playbackManager.play(next, ctx);
    if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
  }, [dedupedActiveTracks, activeTrack, playbackManager, userProductType]);

  const skipQueuePrev = useCallback(() => {
    if (!dedupedActiveTracks.length) return;
    const all = dedupedActiveTracks;
    const ctx: PlayPlaylistContext = { playlistTracks: all };

    if (!activeTrack?.id) {
      const pick = all[all.length - 1]!;
      setActiveTrack(pick);
      void playbackManager.play(pick, ctx);
      if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
      return;
    }

    if (all.length < 2) {
      void playbackManager.play(activeTrack, ctx);
      if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
      return;
    }

    const idx = all.findIndex((t) => t.id === activeTrack.id);
    const prevIdx = idx >= 0 ? (idx - 1 + all.length) % all.length : all.length - 1;
    const prev = all[prevIdx]!;
    setActiveTrack(prev);
    void playbackManager.play(prev, ctx);
    if (userProductType !== "premium") setPlaybackUiBump((b) => b + 1);
  }, [dedupedActiveTracks, activeTrack, playbackManager, userProductType]);

  // Keep UI queue aligned when the Web Playback SDK advances within a batched `uris` play.
  useEffect(() => {
    if (userProductType !== "premium") return;
    const sid = sdkPlayback?.trackId;
    if (!sid || !dedupedActiveTracks.length) return;
    if (activeTrack?.id === sid) return;
    const hit = dedupedActiveTracks.find((t) => t.id === sid);
    if (hit) setActiveTrack(hit);
  }, [
    userProductType,
    sdkPlayback?.trackId,
    dedupedActiveTracks,
    activeTrack?.id,
  ]);

  // Premium: Web Playback SDK pauses when the active track finishes; mirror “next” behaviour.
  useEffect(() => {
    if (userProductType !== "premium") {
      sdkPrevPlaybackRef.current = sdkPlayback;
      return;
    }

    const prev = sdkPrevPlaybackRef.current;
    sdkPrevPlaybackRef.current = sdkPlayback;

    if (
      !sdkPlayback ||
      !activePlaylist ||
      dedupedActiveTracks.length < 2 ||
      !activeTrack?.id
    ) {
      return;
    }
    if (!prev) return;

    const alignsWithUi =
      sdkPlayback.trackId === activeTrack.id && prev.trackId === activeTrack.id;
    const duration =
      sdkPlayback.duration > 0 ? sdkPlayback.duration : prev.duration;
    const pausedNearEnd =
      sdkPlayback.paused &&
      duration > 2000 &&
      sdkPlayback.position >= duration - 800;
    const wasPlaying = !prev.paused && prev.trackId === activeTrack.id;
    const endedNaturally = alignsWithUi && wasPlaying && pausedNearEnd;

    if (endedNaturally && !sdkQueueAdvanceLockRef.current) {
      sdkQueueAdvanceLockRef.current = true;
      skipQueueNext();
      window.setTimeout(() => {
        sdkQueueAdvanceLockRef.current = false;
      }, 1500);
    }
  }, [
    sdkPlayback,
    activePlaylist,
    dedupedActiveTracks.length,
    activeTrack?.id,
    userProductType,
    skipQueueNext,
  ]);

  const openTrackView = useCallback(() => {
    if (!activeTrack) return;
    setVisualMode("track");
  }, [activeTrack]);

  const handleRemovePlaylist = useCallback(
    (id: string) => {
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
      if (activePlaylistId === id) {
        const remaining = playlists.filter((p) => p.id !== id);
        setActivePlaylistId(remaining[0]?.id ?? null);
        if (remaining.length === 0) {
          setActiveTrack(null);
          setVisualMode("default");
        }
      }
    },
    [activePlaylistId, playlists]
  );

  // Premium: two-phase load — summary (profile + playlist list) is fast; rest
  // (recent) runs next. Default visualizer queue is Recently Played once `rest`
  // returns. Liked songs load progressively after: first N pages, then one
  // page at a time in the background.
  useEffect(() => {
    if (!entered || userProductType !== "premium") return;
    let cancelled = false;
    const emptyLib = (): UserLibraryResponse => ({
      profile: null,
      playlists: [],
      liked: null,
      recent: null,
    });
    const LIKED_PAGE = 50;
    const LIKED_INITIAL_MAX = 200;
    (async () => {
      setLikedTracks([]);
      setLikedNextOffset(null);
      likedInFlightRef.current.clear();
      setLikedInitialFetchDone(false);
      setLibraryRestLoaded(false);
      setLibraryLoading(true);
      try {
        const res = await authLibraryFetch(
          "/api/spotify/user/library?mode=summary"
        );
        if (cancelled) return;
        if (!res.ok) {
          console.warn("[page] library summary", res.status);
          setUserLibrary(emptyLib());
          if (!cancelled) setLikedInitialFetchDone(true);
          return;
        }
        const sum = (await res.json()) as UserLibraryResponse;
        if (cancelled) return;
        setUserLibrary(sum);
      } catch (e) {
        console.error("[page] library summary", e);
        if (!cancelled) setUserLibrary(emptyLib());
        if (!cancelled) setLikedInitialFetchDone(true);
      } finally {
        if (!cancelled) setLibraryLoading(false);
      }
      if (cancelled) return;
      void (async () => {
        try {
          try {
            const res = await authLibraryFetch(
              "/api/spotify/user/library?mode=rest"
            );
            if (cancelled) return;
            if (!res.ok) {
              console.warn("[page] library rest", res.status);
            } else {
              const rest = (await res.json()) as UserLibraryResponse;
              if (cancelled) return;
              setUserLibrary((prev) =>
                prev
                  ? {
                      ...prev,
                      recent: rest.recent ?? null,
                    }
                  : rest
              );
            }
          } catch (e) {
            console.error("[page] library rest", e);
          }
          if (!cancelled) setLibraryRestLoaded(true);
          if (cancelled) return;
          // Phase 1: sequential pages up to ~200 tracks (4 × 50) or until done.
          // State updates after the loop (one commit) to avoid 4× WebGL atlas rebuilds
          // while the user is already depth-scrolling.
          let acc: NormalizedTrack[] = [];
          let nextOff: number | null = 0;
          let didLoadLikedPage = false;
          while (nextOff !== null && !cancelled) {
            if (likedInFlightRef.current.has(nextOff)) {
              break;
            }
            likedInFlightRef.current.add(nextOff);
            let r: Response;
            try {
              r = await authLibraryFetch(
                `/api/spotify/user/library?type=liked&limit=${LIKED_PAGE}&offset=${nextOff}`
              );
            } finally {
              likedInFlightRef.current.delete(nextOff);
            }
            if (!r.ok) {
              console.warn("[page] library liked (initial page)", r.status);
              if (acc.length) {
                setLikedTracks(acc);
                setLikedNextOffset(null);
                setUserLibrary((prev) =>
                  prev
                    ? { ...prev, liked: buildLikedPlaylist(acc) }
                    : prev
                );
              }
              return;
            }
            const j = (await r.json()) as LikedTracksPageResponse;
            if (j.tracks.length === 0) {
              setLikedTracks(acc);
              setLikedNextOffset(j.nextOffset);
              setUserLibrary((prev) =>
                prev
                  ? { ...prev, liked: buildLikedPlaylist(acc) }
                  : prev
              );
              return;
            }
            acc = [...acc, ...j.tracks];
            nextOff = j.nextOffset;
            didLoadLikedPage = true;
            if (acc.length >= LIKED_INITIAL_MAX || nextOff === null) {
              break;
            }
          }
          if (!cancelled && didLoadLikedPage) {
            setLikedTracks([...acc]);
            setLikedNextOffset(nextOff);
            setUserLibrary((prev) =>
              prev
                ? { ...prev, liked: buildLikedPlaylist([...acc]) }
                : prev
            );
          }
        } finally {
          if (!cancelled) setLikedInitialFetchDone(true);
        }
      })();
    })();
    return () => {
      cancelled = true;
    };
  }, [authLibraryFetch, entered, userProductType]);

  // Phase 2: one /me/tracks page per idle window — no parallel bursts. Do not
  // list loading flags in the dependency array or cleanup cancels in-flight work.
  useEffect(() => {
    if (!entered || userProductType !== "premium" || likedNextOffset === null) {
      return;
    }
    const off = likedNextOffset;
    let cancelled = false;
    const LIKED_PAGE = 50;
    const doFetch = async () => {
      if (cancelled) return;
      if (likedInFlightRef.current.has(off)) {
        // Another in-flight handoff (e.g. React Strict Mode); retry on next turn.
        setTimeout(() => {
          if (!cancelled) void doFetch();
        }, 0);
        return;
      }
      likedInFlightRef.current.add(off);
      setLikedLoadingMore(true);
      try {
        const r = await authLibraryFetch(
          `/api/spotify/user/library?type=liked&limit=${LIKED_PAGE}&offset=${off}`
        );
        if (cancelled) return;
        if (!r.ok) {
          setLikedNextOffset(null);
          return;
        }
        const j = (await r.json()) as LikedTracksPageResponse;
        if (cancelled) return;
        setLikedTracks((prev) => {
          const merged = [...prev, ...j.tracks];
          setUserLibrary((p) => (p ? { ...p, liked: buildLikedPlaylist(merged) } : p));
          return merged;
        });
        setLikedNextOffset(j.nextOffset);
      } catch (e) {
        console.error("[page] library liked (background page)", e);
        if (!cancelled) setLikedNextOffset(null);
      } finally {
        likedInFlightRef.current.delete(off);
        setLikedLoadingMore(false);
      }
    };
    const tick = () => {
      void doFetch();
    };
    const idleId =
      typeof requestIdleCallback !== "undefined"
        ? requestIdleCallback(tick, { timeout: 3000 })
        : null;
    const timeoutId = idleId == null ? setTimeout(tick, 0) : null;
    return () => {
      cancelled = true;
      if (idleId != null && typeof cancelIdleCallback === "function") {
        cancelIdleCallback(idleId);
      }
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [authLibraryFetch, entered, likedNextOffset, userProductType]);

  // If Liked is the active queue, keep `playlists[0]` in sync as pages append
  // (avoids re-building other playlists; UserLibrary still reads from userLibrary.liked).
  useEffect(() => {
    if (activePlaylistId !== SVP_PLAYLIST_LIKED_ID) return;
    if (likedTracks.length === 0) return;
    setPlaylists([buildLikedPlaylist(likedTracks)]);
  }, [activePlaylistId, likedTracks]);

  // When nothing is active yet: default premium users to Recently Played, else Liked, else first user playlist.
  useEffect(() => {
    if (libraryLoading) return;
    if (userProductType !== "premium" || !entered) return;
    if (autoFirstPlaylistRef.current) return;
    if (playlists.length > 0) return;
    if (activePlaylistId) return;

    if (
      libraryRestLoaded &&
      userLibrary?.recent &&
      userLibrary.recent.tracks.length > 0
    ) {
      autoFirstPlaylistRef.current = true;
      applyUserPlaylist(userLibrary.recent);
      return;
    }

    if (!likedInitialFetchDone) return;
    if (userLibrary?.liked) {
      autoFirstPlaylistRef.current = true;
      applyUserPlaylist(userLibrary.liked);
      return;
    }
    if (userLibrary?.playlists?.length) {
      autoFirstPlaylistRef.current = true;
      const id = userLibrary.playlists[0]!.id;
      void (async () => {
        const ok = await handleSelectUserPlaylist(id);
        if (!ok) autoFirstPlaylistRef.current = false;
      })();
    }
  }, [
    activePlaylistId,
    applyUserPlaylist,
    entered,
    handleSelectUserPlaylist,
    libraryLoading,
    libraryRestLoaded,
    likedInitialFetchDone,
    playlists.length,
    userLibrary,
    userProductType,
  ]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && visualMode === "track") {
        handleExitTrackMode();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visualMode, handleExitTrackMode]);

  // Landing → playground handoff for the preview tab.
  // Returns `true` when the playlist loaded successfully so the landing
  // overlay can fade itself out.
  const handleEnterPreview = useCallback(
    async (input: string): Promise<boolean> => {
      const loaded = await handleLoadPlaylist(input);
      if (!loaded) return false;
      setEntered(true);
      return true;
    },
    [handleLoadPlaylist]
  );

  // Mirror of the hook's `error` into a ref so the landing overlay
  // can read the latest value immediately after `handleEnterPreview`
  // resolves, without having to prop-drill a state that also flips
  // for the ambient background fetch.
  const errorRef = useRef<string | null>(null);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);
  const getPreviewError = useCallback(() => errorRef.current, []);

  // Landing → playground handoff after a successful Premium login. We
  // intentionally don't auto-switch playlists here — the ambient
  // background playlist keeps providing a scene until the user adds
  // their own via the ControlCard. Capturing the product type here
  // is what flips the PlaybackManager from "embed" to "SDK".
  const handleEnterPremium = useCallback(
    (_displayName: string | null, product: "premium") => {
      setOauthSession(true);
      setMePollAfterLogin(false);
      setUserProductType(product);
      setEntered(true);
    },
    []
  );

  const handleEnterWhileMePending = useCallback(() => {
    setOauthSession(true);
    setMePollAfterLogin(true);
    setEntered(true);
  }, []);

  useEffect(() => {
    if (!entered || !mePollAfterLogin) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 30 && !cancelled; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 2500 : 10_000));
        try {
          const r = await fetch("/api/auth/me", {
            credentials: "include",
            cache: "no-store",
          });
          if (cancelled) return;
          if (r.ok) {
            const me = (await r.json()) as { product: string };
            setMePollAfterLogin(false);
            if (me.product === "premium") setUserProductType("premium");
            else if (me.product === "open") setUserProductType("open");
            else setUserProductType("free");
            setOauthSession(true);
            return;
          }
        } catch {
          /* keep polling */
        }
      }
      if (!cancelled) {
        setMePollAfterLogin(false);
        console.warn(
          "[page] /api/auth/me polling exhausted after login — refresh if library or Premium features never appear"
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entered, mePollAfterLogin]);

  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Still leave the playground so stale UI cannot pretend to be signed in.
    }
    window.location.replace("/");
  }, []);

  const showLanding = !entered;

  return (
    <main
      className={`app ${entered ? "app--entered" : "app--landing"}${
        entered && galleryStyle !== "orbit" ? " app--elastic-gallery" : ""
      }`}
    >
      {(!entered || galleryStyle === "orbit") && (
        <SpotifyVisualizer
          tracks={visualizerTracks}
          onTrackSelect={handleSelectTrack}
          dim={visualMode === "track" || !entered}
        />
      )}
      {entered && galleryStyle === "elastic_lag" && (
        <ElasticGridVisualizer
          key={`${activePlaylistId ?? "ambient"}-${visualizerTracks.length}`}
          tracks={visualizerTracks}
          onTrackSelect={handleSelectTrack}
        />
      )}
      {/* Recedes the live WebGL scene behind the glass UI (orbit mode only). */}
      {entered && visualMode === "default" && galleryStyle === "orbit" && (
        <div className="app__visualizer-veil" aria-hidden />
      )}

      <AnimatePresence mode="wait">
        {visualMode === "track" && activeTrack && entered && (
          <motion.div
            key="track"
            className="app__track"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6 }}
          >
            <TrackDistortion
              track={activeTrack}
              previous={previousTracks}
              upcoming={upcomingTracks}
              onQueueClick={handleSelectTrack}
              onLeaveBack={handleExitTrackMode}
            />
            <InAppNowPlayingPill
              track={activeTrack}
              sdkPlayback={userProductType === "premium" ? sdkPlayback : null}
              pausedApproxPreview={pausedApproxForTrackChrome}
              canSkipQueue={canSkipQueue}
              onTogglePlay={() => void handlePlaybackToggle()}
              onPreviousInQueue={skipQueuePrev}
              onNextInQueue={skipQueueNext}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Playground overlays — hidden while the landing screen is up. */}
      {entered && visualMode === "default" && (
        <>
          <InstructionCard />
          <PlaygroundDock
            galleryStyle={galleryStyle}
            onGalleryStyleChange={setGalleryStyle}
            userProductType={userProductType}
            userLibrary={userLibrary}
            libraryLoading={libraryLoading}
            activePlaylistId={activePlaylistId}
            fetchingSpotifyId={fetchingSpotifyId}
            onApplyPlaylist={applyUserPlaylist}
            onSelectUserPlaylist={handleSelectUserPlaylist}
            onAddByUrl={handleLoadPlaylist}
            addLoading={loading}
            addError={error}
            playlists={playlists}
            onPlaylistSelect={setActivePlaylistId}
            onAddPlaylist={handleLoadPlaylist}
            onRemovePlaylist={handleRemovePlaylist}
            controlLoading={loading}
            controlError={error}
            onLogout={oauthSession ? handleLogout : undefined}
            dockPlayback={
              activeTrack
                ? {
                    track: activeTrack,
                    paused: dockPlaybackPaused,
                    canSkipQueue,
                    onOpenTrackView: openTrackView,
                    onTogglePlay: () => void handlePlaybackToggle(),
                    onPrev: skipQueuePrev,
                    onNext: skipQueueNext,
                  }
                : null
            }
          />
        </>
      )}

      {/* Landing layer — full overlay until the user enters. */}
      <AnimatePresence>
        {showLanding && (
          <LandingOverlay
            key="landing"
            onEnterPreview={handleEnterPreview}
            onEnterPremium={handleEnterPremium}
            onEnterWhileMePending={handleEnterWhileMePending}
            getPreviewError={getPreviewError}
            progress={progress}
          />
        )}
      </AnimatePresence>

      <div
        className={`app__player ${
          visualMode === "track" && userProductType !== "premium"
            ? "app__player--visible"
            : ""
        }`}
      >
        {/* For Premium users the Web Playback SDK streams full tracks
            directly — keep the embed mounted (so the iframe API script
            stays warm in case the SDK later fails and we fall back),
            but feed it `trackId={null}` so it never starts its own
            playback and collide with the SDK. For everyone else the
            embed is the sole engine and we wire the current track id
            straight through. */}
        <SpotifyEmbedPlayer
          ref={playerRef}
          trackId={
            userProductType === "premium" ? null : activeTrack?.id ?? null
          }
          autoPlay={userProductType !== "premium"}
          hidden={
            visualMode !== "track" || userProductType === "premium"
          }
        />
      </div>
    </main>
  );
}
