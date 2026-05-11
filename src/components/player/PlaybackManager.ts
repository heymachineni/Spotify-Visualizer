/**
 * Dual playback engine.
 *
 * The app has two "players" now:
 *
 *   - Embed (open.spotify.com/embed) — already shipping, used for
 *     preview mode (30-second clips). Requires nothing beyond the
 *     iframe script. Lives at components/player/SpotifyEmbedPlayer.tsx.
 *
 *   - Web Playback SDK — full-track playback for Premium accounts.
 *     Requires OAuth with `streaming` + the playback-control scopes.
 *     Plumbed through lib/spotifyWebPlayer.ts.
 *
 * `PlaybackManager` picks the right one per `play(track)` call based
 * on the captured `productType`. If the SDK fails (expired token,
 * account mismatch, script load error, …) it silently degrades to the
 * embed player — the user still gets 30-second previews rather than a
 * silent UI.
 *
 * Deliberately framework-agnostic: no React imports. A thin hook
 * (`src/hooks/usePlaybackManager.ts`) wraps it for the app page.
 */

import type { NormalizedTrack } from "@/lib/types";
import type { SpotifyEmbedPlayerHandle } from "./SpotifyEmbedPlayer";
import {
  createSpotifyWebPlayer,
  playTrackOnDevice,
  playTrackUrisOnDevice,
  SPOTIFY_PLAY_URI_BATCH_MAX,
  transferPlaybackHere,
  type SpotifyPlayerInstance,
} from "@/lib/spotifyWebPlayer";

/**
 * Matches the `product` field returned by /v1/me. "open" is what
 * Spotify labels non-logged-in accounts for some regions; we treat
 * it the same as "free" for playback purposes.
 */
export type UserProductType = "premium" | "free" | "open" | "unknown";

/** `player_state_changed` from the Web Playback SDK (ms positions). */
export type SdkPlaybackState = {
  paused: boolean;
  position: number;
  duration: number;
  trackId: string | null;
};

export type PlayPlaylistContext = {
  /** In-order queue for Premium SDK `uris` batches (playlist / active queue). */
  playlistTracks: NormalizedTrack[];
};

export interface PlaybackManagerOptions {
  /** Current embed player handle. Ref is passed by value — we re-read it on every call. */
  getEmbedHandle: () => SpotifyEmbedPlayerHandle | null;
  /** Product type from /v1/me. Returned fresh each call so we honor live updates. */
  getProductType: () => UserProductType;
  /** Optional device name override (shown in Spotify Connect). */
  deviceName?: string;
}

/**
 * Public surface the app calls — `play(track)` / `pause()` / `dispose()`.
 * Internally it lazy-initializes the SDK on the first premium play so
 * non-premium sessions never pay the SDK load cost.
 */
export class PlaybackManager {
  private readonly opts: PlaybackManagerOptions;
  private sdkPlayer: SpotifyPlayerInstance | null = null;
  private sdkDeviceId: string | null = null;
  /**
   * Best-effort for **embed-only** UX: Spotify’s iframe UI doesn’t tell us whether
   * audio is paused, so we approximate from our own pause/resume/toggle/play calls.
   * Premium playback reads real state from SDK via `SdkPlaybackState` instead.
   */
  private embedPausedApprox = true;
  /** In-flight init promise — prevents double-connect on rapid clicks. */
  private sdkInitPromise: Promise<boolean> | null = null;
  /**
   * Sticky flag: once the SDK has failed (token expired, free account,
   * script couldn't load, …) we stop retrying for the life of this
   * page load and fall back to the embed player.
   */
  private sdkFailed = false;
  private playbackStateListener: ((s: SdkPlaybackState | null) => void) | null =
    null;

  constructor(opts: PlaybackManagerOptions) {
    this.opts = opts;
  }

  /**
   * Play the given track. Decides SDK-vs-embed per call so the choice
   * stays correct if the user's product type changes (e.g. silently
   * goes "premium → free" mid-session).
   */
  async play(
    track: NormalizedTrack,
    playlistCtx?: PlayPlaylistContext | null
  ): Promise<void> {
    if (!track?.id) return;
    const product = this.opts.getProductType();
    const premium = product === "premium" && !this.sdkFailed;

    if (premium) {
      try {
        await this.playViaSdk(track, playlistCtx ?? null);
        return;
      } catch (err) {
        // First SDK failure → fall through to embed for this click
        // AND every subsequent click this session. Better to give
        // the user consistent 30s previews than flip-flop between
        // players.
        console.warn("[playback] sdk play failed, falling back to embed", err);
        this.sdkFailed = true;
      }
    }

    this.playViaEmbed(track);
  }

  /** Pause the currently-active engine. Safe to call when nothing is playing. */
  async pause(): Promise<void> {
    // Try SDK first — if it wasn't the active engine, `pause()` is a
    // no-op for it and the embed call below still fires.
    if (this.sdkPlayer) {
      try {
        await this.sdkPlayer.pause();
      } catch {
        /* ignore: pause-on-idle is fine */
      }
    }
    this.opts.getEmbedHandle()?.pause();
    this.embedPausedApprox = true;
  }

  /**
   * Resume whatever engine last started playback (`embed` for preview tiers,
   * SDK for Premium unless it failed over to embed).
   */
  async resume(): Promise<void> {
    const product = this.opts.getProductType();
    const useSdk =
      product === "premium" && !this.sdkFailed && this.sdkPlayer != null;
    const player = this.sdkPlayer;
    if (useSdk && player) {
      try {
        await player.resume();
        return;
      } catch {
        /* fall through — e.g. stale device; embed may still resume */
      }
    }
    this.opts.getEmbedHandle()?.resume();
    this.embedPausedApprox = false;
  }

  /**
   * Pause ↔ resume toggle. Prefer this for transport buttons so Premium users
   * hit the SDK’s native toggle; preview users alternate embed pause/resume.
   */
  async togglePlay(): Promise<void> {
    const product = this.opts.getProductType();
    const premium =
      product === "premium" && !this.sdkFailed && this.sdkPlayer != null;
    const player = this.sdkPlayer;
    if (premium && player) {
      try {
        await player.togglePlay();
      } catch (err) {
        console.warn("[playback] sdk togglePlay failed", err);
      }
      return;
    }

    const embed = this.opts.getEmbedHandle();
    if (!embed) return;
    if (this.embedPausedApprox) {
      embed.resume();
      this.embedPausedApprox = false;
    } else {
      embed.pause();
      this.embedPausedApprox = true;
    }
  }

  /** Preview embed transport only — approximate paused state between toggles. */
  getApproxEmbedPaused(): boolean {
    return this.embedPausedApprox;
  }

  /**
   * Subscribe to Web Playback `player_state_changed` (Premium SDK only).
   * Pass `null` to clear. Used for the in-app track page now-playing bar.
   */
  setPlaybackStateListener(
    l: ((s: SdkPlaybackState | null) => void) | null
  ): void {
    this.playbackStateListener = l;
  }

  /** Tear down SDK resources. Embed cleanup is handled by React. */
  dispose(): void {
    this.playbackStateListener = null;
    this.sdkPlayer?.disconnect();
    this.sdkPlayer = null;
    this.sdkDeviceId = null;
    this.sdkInitPromise = null;
  }

  // ---------- engine-specific paths ----------

  private async playViaSdk(
    track: NormalizedTrack,
    playlistCtx: PlayPlaylistContext | null
  ): Promise<void> {
    console.log("[playback] using spotify sdk");
    await this.ensureSdkReady();
    if (!this.sdkDeviceId) {
      throw new Error("SDK ready but no device id captured");
    }

    const list = playlistCtx?.playlistTracks?.filter((t) => t?.id) ?? [];
    if (list.length >= 2) {
      let start = list.findIndex((t) => t.id === track.id);
      if (start < 0) start = 0;
      const windowList = list.slice(start, start + SPOTIFY_PLAY_URI_BATCH_MAX);
      const uris = windowList.map((t) => `spotify:track:${t.id}`);
      await playTrackUrisOnDevice(this.sdkDeviceId, uris);
      return;
    }

    await playTrackOnDevice(this.sdkDeviceId, `spotify:track:${track.id}`);
  }

  private playViaEmbed(track: NormalizedTrack): void {
    console.log("[playback] using spotify embed preview");
    const embed = this.opts.getEmbedHandle();
    if (!embed) {
      console.warn("[playback] embed handle not yet available, ignoring click");
      return;
    }
    embed.playTrack(track.id);
    this.embedPausedApprox = false;
  }

  /**
   * Lazy-init the SDK: load the script, wire listeners, call
   * `connect()`, wait for the `ready` device id, then transfer
   * playback to it. Returns `true` if the SDK is ready to stream.
   *
   * The whole pipeline is wrapped in a memoized promise so rapid
   * track clicks during initialization collapse to a single init.
   */
  private ensureSdkReady(): Promise<boolean> {
    if (this.sdkDeviceId) return Promise.resolve(true);
    if (this.sdkInitPromise) return this.sdkInitPromise;

    this.sdkInitPromise = (async () => {
      const READY_MS = 45_000;
      const HANDSHAKE_TRIES = 2;
      let lastErr: unknown;

      for (let attempt = 0; attempt < HANDSHAKE_TRIES; attempt++) {
        let player: SpotifyPlayerInstance | null = null;
        try {
          player = await createSpotifyWebPlayer({
            name: this.opts.deviceName ?? "Visual Playground Player",
          });

          const ready = new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error("Spotify SDK did not report ready in time"));
            }, READY_MS);

            player!.addListener("ready", ({ device_id }) => {
              clearTimeout(timer);
              resolve(device_id);
            });

            player!.addListener("not_ready", ({ device_id }) => {
              console.warn("[playback] sdk device not ready:", device_id);
            });

            player!.addListener("initialization_error", (e) => {
              clearTimeout(timer);
              reject(new Error(`initialization_error: ${e.message}`));
            });
            player!.addListener("authentication_error", (e) => {
              clearTimeout(timer);
              reject(new Error(`authentication_error: ${e.message}`));
            });
            player!.addListener("account_error", (e) => {
              clearTimeout(timer);
              reject(new Error(`account_error: ${e.message}`));
            });
            player!.addListener("playback_error", (e) => {
              console.warn("[playback] sdk playback_error:", e.message);
            });
          });

          const connected = await player.connect();
          if (!connected) {
            player.disconnect();
            player = null;
            throw new Error("Spotify SDK connect() returned false");
          }

          const deviceId = await ready;

          this.sdkPlayer = player;
          this.sdkDeviceId = deviceId;

          player.addListener("player_state_changed", (state) => {
            const fn = this.playbackStateListener;
            if (!fn) return;
            if (!state) {
              fn(null);
              return;
            }
            const id = state.track_window?.current_track?.id ?? null;
            fn({
              paused: state.paused,
              position: state.position,
              duration: state.duration,
              trackId: id,
            });
          });

          await transferPlaybackHere(deviceId, { play: false });

          return true;
        } catch (e) {
          lastErr = e;
          try {
            player?.disconnect();
          } catch {
            /* ignore */
          }
          if (
            e instanceof Error &&
            e.message.includes("ready in time") &&
            attempt < HANDSHAKE_TRIES - 1
          ) {
            console.warn(
              "[playback] SDK handshake slow — retrying device connection once"
            );
            await new Promise((r) => setTimeout(r, 500));
            continue;
          }
          throw e;
        }
      }

      throw lastErr instanceof Error ? lastErr : new Error("SDK init failed");
    })();

    // Clear the memoized promise on failure so future plays can retry
    // (the sticky `sdkFailed` flag on `play()` prevents infinite
    // retries for the same session).
    this.sdkInitPromise.catch(() => {
      this.sdkInitPromise = null;
    });

    return this.sdkInitPromise;
  }
}
