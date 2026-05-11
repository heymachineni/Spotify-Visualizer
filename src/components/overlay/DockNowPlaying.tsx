"use client";

import type { NormalizedTrack } from "@/lib/types";
import {
  LucidePlaybackPause,
  LucidePlaybackPlay,
  LucidePlaybackSkipBack,
  LucidePlaybackSkipFwd,
} from "@/components/media/lucidePlayback";

export type DockNowPlayingProps = {
  track: NormalizedTrack;
  paused: boolean;
  canSkip: boolean;
  onOpenTrackView: () => void;
  onTogglePlay: () => void | Promise<void>;
  onPrevious: () => void;
  onNext: () => void;
};

/**
 * Homepage dock mini-player — capsule with circular art and prev · play · next.
 */
export default function DockNowPlaying({
  track,
  paused,
  canSkip,
  onOpenTrackView,
  onTogglePlay,
  onPrevious,
  onNext,
}: DockNowPlayingProps) {
  return (
    <div className="dock-np-am">
      <button
        type="button"
        className="dock-np-am__tap"
        onClick={onOpenTrackView}
        aria-label={`${track.title} — open Now Playing`}
        data-ui-tip="Show Now Playing"
      >
        <span className="dock-np-am__cover" aria-hidden>
          {track.albumCover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="dock-np-am__img"
              src={track.albumCover}
              alt=""
              width={24}
              height={24}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : (
            <span className="dock-np-am__img dock-np-am__img--ph" />
          )}
        </span>
        <span className="dock-np-am__text">
          <span className="dock-np-am__song">{track.title}</span>
          <span className="dock-np-am__creator">{track.artist || ""}</span>
        </span>
      </button>
      <div className="dock-np-am__controls">
        <button
          type="button"
          className="dock-np-am__btn dock-np-am__btn--skip"
          onClick={(e) => {
            e.stopPropagation();
            onPrevious();
          }}
          aria-label="Previous track"
          data-ui-tip="Previous"
          disabled={!canSkip}
        >
          <LucidePlaybackSkipBack size={15} />
        </button>
        <button
          type="button"
          className="dock-np-am__btn dock-np-am__btn--play"
          onClick={(e) => {
            e.stopPropagation();
            void onTogglePlay();
          }}
          aria-label={paused ? "Play" : "Pause"}
          data-ui-tip={paused ? "Play" : "Pause"}
        >
          {paused ? (
            <LucidePlaybackPlay size={14} />
          ) : (
            <LucidePlaybackPause size={14} />
          )}
        </button>
        <button
          type="button"
          className="dock-np-am__btn dock-np-am__btn--skip"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Next track"
          data-ui-tip="Next"
          disabled={!canSkip}
        >
          <LucidePlaybackSkipFwd size={15} />
        </button>
      </div>
    </div>
  );
}
