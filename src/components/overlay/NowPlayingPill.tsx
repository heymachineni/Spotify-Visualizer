"use client";

import type { NormalizedTrack } from "@/lib/types";
import type { SdkPlaybackState } from "@/components/player/PlaybackManager";
import { useEffect, useState } from "react";
import {
  LucidePlaybackPause,
  LucidePlaybackPlay,
  LucidePlaybackSkipBack,
  LucidePlaybackSkipFwd,
} from "@/components/media/lucidePlayback";

type Props = {
  track: NormalizedTrack;
  sdkPlayback: SdkPlaybackState | null;
  pausedApproxPreview?: boolean;
  canSkipQueue: boolean;
  onTogglePlay: () => void;
  onPreviousInQueue: () => void;
  onNextInQueue: () => void;
};

/**
 * Track-mode bottom bar — lucide transports + unified hover tips.
 */
export function InAppNowPlayingPill({
  track,
  sdkPlayback,
  pausedApproxPreview = false,
  canSkipQueue,
  onTogglePlay,
  onPreviousInQueue,
  onNextInQueue,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const sdkMatches = sdkPlayback != null && sdkPlayback.trackId === track.id;
  const paused = sdkMatches ? sdkPlayback.paused : pausedApproxPreview;

  const durationMs =
    sdkMatches && sdkPlayback && sdkPlayback.duration > 0 ? sdkPlayback.duration : 0;
  const progressMs =
    sdkMatches && sdkPlayback
      ? Math.max(0, Math.min(sdkPlayback.position, durationMs || sdkPlayback.position))
      : 0;
  const pct =
    sdkMatches && sdkPlayback && durationMs > 0
      ? Math.min(100, (progressMs / durationMs) * 100)
      : 0;
  const showProgress = sdkMatches && durationMs > 0;

  return (
    <div className="np-am np-am--track" aria-label="Playback">
      <div className="np-am__cover" aria-hidden>
        {track.albumCover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="np-am__img"
            src={track.albumCover}
            alt=""
            width={44}
            height={44}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <div className="np-am__img np-am__img--ph" aria-hidden />
        )}
      </div>

      <div className="np-am__body">
        <div className="np-am__meta">
          <span className="np-am__title" title={track.title}>
            {track.title}
          </span>
          <span className="np-am__subtitle">{track.artist || " — "}</span>
        </div>
        {showProgress ? (
          <div
            className="np-am__scrub"
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Track progress"
          >
            <div className="np-am__scrub-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <div className="np-am__scrub np-am__scrub--idle" aria-hidden />
        )}
      </div>

      <div className="np-am__deck">
        <button
          type="button"
          className="np-am__ctl np-am__ctl--skip"
          aria-label="Previous track"
          data-ui-tip="Previous"
          disabled={!canSkipQueue}
          onClick={onPreviousInQueue}
        >
          <LucidePlaybackSkipBack size={19} />
        </button>
        <button
          type="button"
          className="np-am__ctl np-am__ctl--main"
          aria-label={paused ? "Play" : "Pause"}
          data-ui-tip={paused ? "Play" : "Pause"}
          onClick={onTogglePlay}
        >
          {paused ? (
            <LucidePlaybackPlay size={21} />
          ) : (
            <LucidePlaybackPause size={21} />
          )}
        </button>
        <button
          type="button"
          className="np-am__ctl np-am__ctl--skip"
          aria-label="Next track"
          data-ui-tip="Next"
          disabled={!canSkipQueue}
          onClick={onNextInQueue}
        >
          <LucidePlaybackSkipFwd size={19} />
        </button>
      </div>
    </div>
  );
}
