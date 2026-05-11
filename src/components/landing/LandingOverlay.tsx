"use client";

/**
 * LandingOverlay — full-screen glass layer that sits above the visualizer
 * before the user has "entered" the playground.
 *
 * Structure:
 *   landing-overlay
 *     glass-background
 *     hero-container
 *       logo
 *       headline         (single line — no secondary subtitle)
 *       tabs
 *       tab-content
 *
 * Responsibilities:
 *   1. Render the hero + two tabs ("Connect Spotify" / "Try Preview").
 *   2. On preview-submit: delegate to `onEnterPreview(url)` and, when
 *      the parent reports success, fade out.
 *   3. On "Continue with Spotify": redirect to `/api/auth/login`.
 *   4. When the page returns from `/api/auth/callback` with
 *      `?login=success`, call `/api/auth/me`:
 *        - product === "premium" → call `onEnterPremium(displayName)`
 *        - otherwise             → show free-account message, switch to
 *                                  the "Try Preview" tab.
 *      The OAuth callback also caches `/v1/me` in an HttpOnly cookie so the
 *      browser's first `/api/auth/me` usually avoids a second Spotify call
 *      (429 burst). If `/me` is still rate-limited, `onEnterWhileMePending`
 *      enters the app and the parent polls until profile resolves.
 *
 * While a preview playlist is loading the primary CTA turns into a
 * clean "Fetching 37 / 1250" progress indicator with an inline
 * progress bar. Error messages are friendly one-liners (no raw API
 * dumps).
 */

import { useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { PlaylistFetchProgress } from "@/hooks/useSpotifyPlaylist";
import { spotifyCallbackErrorMessage } from "@/lib/spotifyLoginErrors";

type Tab = "spotify" | "preview";

type MeResponse = {
  id: string;
  displayName: string | null;
  product: string; // "premium" | "free" | "open"
};

interface LandingOverlayProps {
  /**
   * Returns `true` when the preview playlist loaded successfully (the
   * overlay fades out). When `false`, the hook behind the parent has
   * already stored a friendly error message — the parent hands it to
   * us via `getPreviewError()` so we can surface it in the inline
   * error pill under the input.
   */
  onEnterPreview: (input: string) => Promise<boolean>;
  /**
   * Called after a successful premium login. Receives the display
   * name (may be null) plus the raw `product` field from /v1/me
   * ("premium" here by construction, but passed through so the
   * parent can flow it straight into `PlaybackManager` without a
   * second call). Non-premium accounts never reach this callback —
   * they stay on the landing screen with a preview-mode notice.
   */
  onEnterPremium: (
    displayName: string | null,
    product: "premium"
  ) => void;
  /**
   * Spotify returned 429 on `/v1/me` right after login — enter the app
   * anyway (cookie is valid); the parent will poll `/api/auth/me` until
   * Premium vs Free is known.
   */
  onEnterWhileMePending?: () => void;
  /**
   * Invoked after a failed preview submit to read the current error
   * message from the parent hook. We don't accept the error as a
   * prop because the hook's `error` also flips while the ambient
   * background playlist is loading, and we must NEVER surface that
   * as a user-facing error.
   */
  getPreviewError?: () => string | null;
  /** Live "N / total" progress while the preview playlist is loading. */
  progress?: PlaylistFetchProgress | null;
}

export default function LandingOverlay({
  onEnterPreview,
  onEnterPremium,
  onEnterWhileMePending,
  getPreviewError,
  progress = null,
}: LandingOverlayProps) {
  const [tab, setTab] = useState<Tab>("spotify");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Detect the OAuth return and resolve premium vs free. We strip the
  // query params afterwards so a page reload doesn't re-trigger the
  // check, and so the playground URL stays clean.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const login = params.get("login");
    if (!login) return;

    const clean = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete("login");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.toString());
    };

    if (login === "error") {
      const reason = params.get("reason") ?? "unknown";
      setLoginNotice(spotifyCallbackErrorMessage(reason));
      setTab("preview");
      clean();
      return;
    }

    if (login !== "success") {
      clean();
      return;
    }

    (async () => {
      try {
        // Space this call from `POST /api/token` in the OAuth callback so we
        // don't hit Spotify's `/v1/me` in the same burst as the token exchange.
        await new Promise((r) => setTimeout(r, 3_500));
        const res = await fetch("/api/auth/me", {
          cache: "no-store",
          credentials: "include",
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => null)) as {
            detail?: string;
            status?: number;
            error?: string;
          } | null;
          const msg = errJson?.detail?.trim();
          if (res.status === 503 && errJson?.error === "rate_limited") {
            if (onEnterWhileMePending) {
              onEnterWhileMePending();
            } else {
              setLoginNotice(
                "Spotify is temporarily rate-limiting API traffic (HTTP 429). Wait 1–2 minutes, then refresh this page — your login cookie is usually still valid. Preview Mode still works below."
              );
              setTab("preview");
            }
            return;
          } else if (res.status === 502 && errJson?.status === 429) {
            if (onEnterWhileMePending) {
              onEnterWhileMePending();
            } else {
              setLoginNotice(
                "Spotify rate limit (429). Wait a minute, refresh, and try again. Preview Mode still works below."
              );
              setTab("preview");
            }
            return;
          } else if (res.status === 502 && msg) {
            setLoginNotice(
              `Spotify: ${msg.slice(0, 200)}${
                msg.length > 200 ? "…" : ""
              } — If the app is in Development mode, add your Spotify user under “Users and groups” in the developer dashboard. Preview Mode still works.`
            );
          } else if (res.status === 401) {
            setLoginNotice(
              "Not logged in or session expired. Open the app at the same host as SPOTIFY_REDIRECT_URI (e.g. http://127.0.0.1:3000) and try Connect again."
            );
          } else {
            setLoginNotice(
              "Couldn't verify your Spotify account. You can still explore using Preview Mode."
            );
          }
          setTab("preview");
          return;
        }
        const me = (await res.json()) as MeResponse;
        if (me.product === "premium") {
          onEnterPremium(me.displayName, "premium");
        } else {
          setLoginNotice(
            "Looks like your account doesn't have Spotify Premium. You can still explore using Preview Mode."
          );
          setTab("preview");
        }
      } catch {
        setLoginNotice(
          "Couldn't verify your Spotify account. You can still explore using Preview Mode."
        );
        setTab("preview");
      } finally {
        clean();
      }
    })();
  }, [onEnterPremium, onEnterWhileMePending]);

  const handlePreviewSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const value = previewUrl.trim();
      if (!value || submitting) return;
      setPreviewError(null);
      setSubmitting(true);
      try {
        const ok = await onEnterPreview(value);
        if (!ok) {
          // Pull the latest error message from the parent hook if the
          // caller wired the getter; otherwise fall back to a generic
          // one-liner. Either way we never leak raw API text.
          const msg = getPreviewError?.() ?? null;
          setPreviewError(msg ?? "Couldn't load that playlist. Try another link?");
        }
        // On success, page.tsx will unmount this overlay — no need to
        // reset local state.
      } finally {
        setSubmitting(false);
      }
    },
    [previewUrl, submitting, onEnterPreview, getPreviewError]
  );

  const handleSpotifyLogin = () => {
    if (typeof window === "undefined") return;
    window.location.href = `${window.location.origin}/api/auth/login`;
  };

  // Only surface progress / disabled state when the user themselves
  // kicked off a preview load. The hook's `loading` / `progress`
  // values are also true while the ambient background playlist is
  // being fetched, and we must not flash a "Fetching …" bar (or a
  // red error pill) over the landing copy in that case.
  const isLoadingPreview = submitting;
  const showError = !isLoadingPreview ? previewError ?? null : null;
  const previewDisabled = isLoadingPreview || !previewUrl.trim();

  return (
    <motion.div
      className="landing-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      // Block scroll/drag gestures intended for the background visualizer
      // from ever reaching it — the landing screen must feel pinned.
      onWheel={(e) => e.preventDefault()}
      onTouchMove={(e) => e.preventDefault()}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to the visual playground"
    >
      <div className="landing-overlay__glass" aria-hidden />

      <div className="landing-overlay__hero">
        <div className="landing-overlay__logo" aria-hidden>
          🪩
        </div>
        <h1 className="landing-overlay__headline">
          Turn your Spotify playlists
          <br />
          into a living visual experience
        </h1>

        <div
          className="landing-overlay__tabs"
          role="tablist"
          aria-label="How would you like to start?"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "spotify"}
            className={`landing-overlay__tab ${
              tab === "spotify" ? "landing-overlay__tab--active" : ""
            }`}
            onClick={() => setTab("spotify")}
          >
            Connect Spotify
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            className={`landing-overlay__tab ${
              tab === "preview" ? "landing-overlay__tab--active" : ""
            }`}
            onClick={() => setTab("preview")}
          >
            Try Preview
          </button>
        </div>

        {tab === "spotify" ? (
          <div className="landing-overlay__panel" role="tabpanel">
            <button
              type="button"
              className="landing-overlay__primary"
              onClick={handleSpotifyLogin}
            >
              Continue with Spotify
            </button>
            <p className="landing-overlay__caption">
              Works best with Spotify Premium.
              <br />
              No Premium? Try Preview Mode.
            </p>
            {loginNotice && (
              <p className="landing-overlay__notice">{loginNotice}</p>
            )}
          </div>
        ) : (
          <form
            className="landing-overlay__panel"
            role="tabpanel"
            onSubmit={handlePreviewSubmit}
          >
            <p className="landing-overlay__caption">
              Try the visual playground with any playlist.
            </p>
            <div className="landing-overlay__field">
              <input
                type="text"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="https://open.spotify.com/playlist/..."
                value={previewUrl}
                onChange={(e) => setPreviewUrl(e.target.value)}
                aria-label="Spotify playlist link"
                disabled={isLoadingPreview}
              />
              <button
                type="submit"
                className="landing-overlay__primary"
                disabled={previewDisabled}
              >
                {isLoadingPreview ? "Loading…" : "Load playlist"}
              </button>
            </div>

            {isLoadingPreview && (
              <FetchProgress progress={progress} />
            )}

            {loginNotice && !isLoadingPreview && (
              <p className="landing-overlay__notice">{loginNotice}</p>
            )}
            {showError && (
              <p className="landing-overlay__error" role="alert">
                {showError}
              </p>
            )}
          </form>
        )}
      </div>
    </motion.div>
  );
}

/**
 * Thin progress bar + "Fetching N / total" label shown below the
 * preview input while a playlist hydrates. Falls back to a gentle
 * indeterminate message when we don't yet know the total count (that
 * window is usually under a second — just while the playlist's `meta`
 * event is in flight).
 */
function FetchProgress({
  progress,
}: {
  progress: PlaylistFetchProgress | null;
}) {
  const knownTotal = progress && progress.total > 0;
  const pct = knownTotal
    ? Math.min(100, Math.max(0, (progress!.done / progress!.total) * 100))
    : null;

  return (
    <div
      className="landing-overlay__progress"
      role="status"
      aria-live="polite"
    >
      <div className="landing-overlay__progress-label">
        {knownTotal
          ? `Fetching ${progress!.done.toLocaleString()} / ${progress!.total.toLocaleString()} tracks`
          : "Fetching playlist…"}
      </div>
      <div
        className={`landing-overlay__progress-bar ${
          pct === null ? "landing-overlay__progress-bar--indeterminate" : ""
        }`}
        aria-hidden
      >
        <div
          className="landing-overlay__progress-fill"
          style={pct !== null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
