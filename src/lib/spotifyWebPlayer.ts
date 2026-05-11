/**
 * Spotify Web Playback SDK loader + thin typed wrapper.
 *
 * Responsibilities split between this module and `PlaybackManager`:
 *
 *   lib/spotifyWebPlayer.ts        (this file)
 *     - Load https://sdk.scdn.co/spotify-player.js exactly once.
 *     - Construct `new Spotify.Player(...)`.
 *     - Wire the token bridge (`/api/auth/token`) into `getOAuthToken`.
 *     - Expose connect(), disconnect(), play(uri), pause(), togglePlay(),
 *       and transferPlaybackHere(deviceId) with strong types.
 *
 *   components/player/PlaybackManager.ts
 *     - Decides embed vs SDK based on the user's product type.
 *     - Owns the single instance of this wrapper.
 *
 * The SDK only works for Premium users — the manager is the gate that
 * decides whether to even attempt loading this module's code at
 * runtime. Loading the SDK script on a free-tier page is harmless but
 * useless (authentication_error fires on connect).
 */

// ---------- global types ----------

type SpotifyPlayerErrorEvent = { message: string };

type SpotifyPlayerReadyEvent = { device_id: string };

type SpotifyPlaybackState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: { id: string | null; uri: string };
  };
};

type SpotifyPlayerEvent =
  | "ready"
  | "not_ready"
  | "player_state_changed"
  | "initialization_error"
  | "authentication_error"
  | "account_error"
  | "playback_error";

type SpotifyPlayerCtor = new (opts: {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
}) => SpotifyPlayerInstance;

export interface SpotifyPlayerInstance {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  togglePlay: () => Promise<void>;
  addListener: {
    (event: "ready", cb: (data: SpotifyPlayerReadyEvent) => void): void;
    (event: "not_ready", cb: (data: SpotifyPlayerReadyEvent) => void): void;
    (
      event: "player_state_changed",
      cb: (state: SpotifyPlaybackState | null) => void
    ): void;
    (
      event:
        | "initialization_error"
        | "authentication_error"
        | "account_error"
        | "playback_error",
      cb: (err: SpotifyPlayerErrorEvent) => void
    ): void;
    (event: SpotifyPlayerEvent, cb: (arg: unknown) => void): void;
  };
  removeListener: (event: SpotifyPlayerEvent) => void;
  getCurrentState: () => Promise<SpotifyPlaybackState | null>;
}

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: { Player: SpotifyPlayerCtor };
  }
}

// ---------- singleton script loader ----------

let sdkReadyPromise: Promise<void> | null = null;

/**
 * Inject `https://sdk.scdn.co/spotify-player.js` exactly once per
 * page load. The SDK calls `window.onSpotifyWebPlaybackSDKReady`
 * after its bundle evaluates; we convert that callback into a
 * promise so callers can `await` on it.
 *
 * Important: if the script tag already exists (e.g. fast remount),
 * we still resolve when `window.Spotify.Player` appears — previously
 * an early `return` left the promise pending forever.
 */
export function loadSpotifyPlayerSDK(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Spotify SDK cannot load on the server"));
  }
  if (window.Spotify?.Player) return Promise.resolve();
  if (sdkReadyPromise) return sdkReadyPromise;

  sdkReadyPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      if (!window.Spotify?.Player) return;
      settled = true;
      resolve();
    };
    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(msg));
    };

    let rafTries = 0;
    const tryFinishAfterCallback = () => {
      const bump = () => {
        if (settled) return;
        if (window.Spotify?.Player) {
          settled = true;
          resolve();
          return;
        }
        if (++rafTries >= 90) return;
        requestAnimationFrame(bump);
      };
      bump();
    };

    const prev = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      prev?.();
      tryFinishAfterCallback();
    };

    if (document.getElementById("spotify-web-playback-sdk")) {
      if (window.Spotify?.Player) {
        queueMicrotask(finish);
        return;
      }
      let n = 0;
      const max = Math.ceil(45_000 / 50);
      const poll = window.setInterval(() => {
        if (window.Spotify?.Player) {
          clearInterval(poll);
          finish();
        } else if (++n >= max) {
          clearInterval(poll);
          fail("Spotify SDK script present but Player never registered");
        }
      }, 50);
      return;
    }

    const script = document.createElement("script");
    script.id = "spotify-web-playback-sdk";
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => fail("Failed to load Spotify Web Playback SDK");
    document.body.appendChild(script);

    script.addEventListener("load", () => {
      tryFinishAfterCallback();
      window.setTimeout(() => finish(), 0);
    });

    window.setTimeout(() => {
      if (!settled) finish();
      if (!settled) fail("Spotify SDK load timed out");
    }, 65_000);
  });

  sdkReadyPromise.catch(() => {
    sdkReadyPromise = null;
  });

  return sdkReadyPromise;
}

// ---------- token bridge ----------

/**
 * Fetches the OAuth access token from the same-origin proxy route
 * (`/api/auth/token`). The SDK calls `getOAuthToken(cb)` on init and
 * again whenever its internal token is stale — each call re-hits
 * this route so we always pass it whatever is in the cookie.
 */
async function fetchAccessToken(): Promise<string> {
  const res = await fetch("/api/auth/token", { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`token bridge returned ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token bridge returned no access_token");
  return json.access_token;
}

// ---------- player factory ----------

export interface CreateSpotifyWebPlayerOptions {
  /** Human-readable device name shown in "Spotify Connect". */
  name?: string;
  /** 0..1 initial volume. */
  volume?: number;
}

/**
 * Loads the SDK (if it isn't already) and constructs a
 * `Spotify.Player`. Does NOT call `connect()` — callers (i.e.
 * `PlaybackManager`) should wire listeners first and then connect so
 * no events are dropped.
 */
export async function createSpotifyWebPlayer(
  opts: CreateSpotifyWebPlayerOptions = {}
): Promise<SpotifyPlayerInstance> {
  await loadSpotifyPlayerSDK();
  if (!window.Spotify?.Player) {
    throw new Error("Spotify SDK loaded but window.Spotify.Player is missing");
  }

  return new window.Spotify.Player({
    name: opts.name ?? "Visual Playground Player",
    volume: opts.volume ?? 0.6,
    getOAuthToken: (cb) => {
      fetchAccessToken()
        .then((token) => cb(token))
        .catch((err) => {
          // If the token fetch fails the SDK will fire
          // `authentication_error` right after — just log here and
          // let PlaybackManager decide how to recover (typically:
          // fall back to the embed player).
          console.warn("[playback] failed to refresh SDK token", err);
        });
    },
  });
}

// ---------- device transfer ----------

/**
 * Transfer active playback onto `deviceId` (the one the SDK just
 * announced via its `ready` event). `play` toggles whether Spotify
 * should resume/start playback immediately on transfer — we pass
 * `false` so the device is registered but silent until the user
 * actually picks a track.
 */
export async function transferPlaybackHere(
  deviceId: string,
  opts: { play?: boolean } = {}
): Promise<void> {
  const token = await fetchAccessToken();
  const res = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device_ids: [deviceId], play: opts.play ?? false }),
  });
  // Spotify returns 204 on success, 202 when the transfer is queued.
  // Anything >= 300 is a real problem — log so the error is visible
  // in the browser console but don't throw: the SDK will still be
  // live, the user just might have to click a track twice.
  if (res.status >= 300) {
    const detail = await res.text().catch(() => "");
    console.warn(
      `[playback] device transfer returned ${res.status}: ${detail.slice(0, 200)}`
    );
  }
}

/** Spotify Web API cap for `uris` on the play endpoint — enables in-player “next”. */
export const SPOTIFY_PLAY_URI_BATCH_MAX = 50;

/**
 * Start playback of one or more track URIs on the SDK device (`offset.position`
 * indexes into `uris`; first URI is normally the clicked track within the slice).
 * Multiple URIs let Spotify advance through the playlist without issuing a new
 * play command per song (Premium Web Playback SDK).
 */
export async function playTrackUrisOnDevice(
  deviceId: string,
  uris: string[]
): Promise<void> {
  if (uris.length === 0) {
    throw new Error("play URIs list empty");
  }
  const capped =
    uris.length > SPOTIFY_PLAY_URI_BATCH_MAX
      ? uris.slice(0, SPOTIFY_PLAY_URI_BATCH_MAX)
      : uris;

  const token = await fetchAccessToken();
  const res = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(
      deviceId
    )}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uris: capped,
        offset: { position: 0 },
      }),
    }
  );

  if (res.status >= 300) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `play request failed (${res.status}): ${detail.slice(0, 200)}`
    );
  }
}

/**
 * Convenience: single track URI (`uris: [trackUri]`).
 */
export async function playTrackOnDevice(
  deviceId: string,
  trackUri: string
): Promise<void> {
  return playTrackUrisOnDevice(deviceId, [trackUri]);
}
