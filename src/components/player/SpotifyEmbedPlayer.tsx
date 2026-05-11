"use client";

/**
 * Minimal wrapper around Spotify's embedded player (open.spotify.com/embed).
 * Uses the official iFrame API when available (via the script injected on
 * mount) so we can call `play()` / `pause()` programmatically. Falls back to
 * simply re-pointing the iframe src when the API hasn't loaded yet.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

type SpotifyEmbedController = {
  loadUri: (uri: string) => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  destroy?: () => void;
  addListener: (event: string, cb: (data: unknown) => void) => void;
};

type SpotifyIFrameAPI = {
  createController: (
    element: HTMLElement,
    options: { width: string | number; height: string | number; uri: string },
    cb: (controller: SpotifyEmbedController) => void
  ) => void;
};

declare global {
  interface Window {
    onSpotifyIframeApiReady?: (api: SpotifyIFrameAPI) => void;
    SpotifyIframeApi?: SpotifyIFrameAPI;
  }
}

export interface SpotifyEmbedPlayerHandle {
  playTrack: (trackId: string) => void;
  pause: () => void;
  resume: () => void;
}

interface SpotifyEmbedPlayerProps {
  trackId: string | null;
  autoPlay?: boolean;
  hidden?: boolean;
}

const SpotifyEmbedPlayer = forwardRef<
  SpotifyEmbedPlayerHandle,
  SpotifyEmbedPlayerProps
>(function SpotifyEmbedPlayer({ trackId, autoPlay = true, hidden = false }, ref) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<SpotifyEmbedController | null>(null);
  const queuedTrackIdRef = useRef<string | null>(trackId);

  useEffect(() => {
    queuedTrackIdRef.current = trackId;
    if (controllerRef.current && trackId) {
      controllerRef.current.loadUri(`spotify:track:${trackId}`);
      if (autoPlay) {
        // Slight delay — the iframe needs a moment after loadUri.
        setTimeout(() => controllerRef.current?.play(), 250);
      }
    }
  }, [trackId, autoPlay]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const ensureScript = () => {
      if (document.getElementById("spotify-iframe-api")) return;
      const script = document.createElement("script");
      script.id = "spotify-iframe-api";
      script.src = "https://open.spotify.com/embed/iframe-api/v1";
      script.async = true;
      document.body.appendChild(script);
    };

    const initController = (api: SpotifyIFrameAPI) => {
      const mount = mountRef.current;
      if (!mount) return;
      const initialTrackId = queuedTrackIdRef.current ?? "";
      const initialUri = initialTrackId ? `spotify:track:${initialTrackId}` : "";
      api.createController(
        mount,
        { width: "100%", height: 80, uri: initialUri },
        (controller) => {
          controllerRef.current = controller;
          if (initialTrackId && autoPlay) {
            setTimeout(() => controller.play(), 300);
          }
        }
      );
    };

    if (window.SpotifyIframeApi) {
      initController(window.SpotifyIframeApi);
    } else {
      // Chain rather than overwrite — StrictMode / HMR / multiple players
      // would otherwise lose the previous handler (and never get a controller).
      const prev = window.onSpotifyIframeApiReady;
      window.onSpotifyIframeApiReady = (api) => {
        window.SpotifyIframeApi = api;
        try {
          prev?.(api);
        } catch {
          /* ignore */
        }
        initController(api);
      };
      ensureScript();
    }

    return () => {
      controllerRef.current?.destroy?.();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      playTrack: (id: string) => {
        queuedTrackIdRef.current = id;
        const attempt = (): boolean => {
          const ctl = controllerRef.current;
          if (ctl && id === queuedTrackIdRef.current) {
            ctl.loadUri(`spotify:track:${id}`);
            window.setTimeout(() => {
              if (
                queuedTrackIdRef.current === id &&
                controllerRef.current === ctl
              ) {
                ctl.play();
              }
            }, 250);
            return true;
          }
          return false;
        };
        if (typeof window === "undefined") return;
        if (attempt()) return;
        let steps = 0;
        const iv = window.setInterval(() => {
          if (attempt() || ++steps >= 120) window.clearInterval(iv);
        }, 50);
        window.setTimeout(() => window.clearInterval(iv), 6000);
      },
      pause: () => controllerRef.current?.pause(),
      resume: () => controllerRef.current?.resume(),
    }),
    []
  );

  return (
    <div
      className="spotify-embed"
      style={{
        opacity: hidden ? 0 : 1,
        pointerEvents: hidden ? "none" : "auto",
        transition: "opacity 400ms ease",
      }}
    >
      <div ref={mountRef} />
    </div>
  );
});

export default SpotifyEmbedPlayer;
