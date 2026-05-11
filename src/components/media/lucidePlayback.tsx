"use client";

import { CornerUpLeft, Pause, Play, SkipBack, SkipForward } from "lucide-react";

const stroked = { strokeWidth: 1.75 };

export type PlaybackIconBase = {
  size?: number;
  className?: string;
};

/** Lucide media glyphs — unified stroke weight for playback chrome. */

export function LucidePlaybackSkipBack({ size = 15, className }: PlaybackIconBase) {
  return <SkipBack {...stroked} size={size} className={className} aria-hidden />;
}

export function LucidePlaybackSkipFwd({ size = 15, className }: PlaybackIconBase) {
  return (
    <SkipForward {...stroked} size={size} className={className} aria-hidden />
  );
}

export function LucidePlaybackPlay({ size = 14, className }: PlaybackIconBase) {
  return <Play {...stroked} size={size} className={className} aria-hidden />;
}

export function LucidePlaybackPause({ size = 14, className }: PlaybackIconBase) {
  return <Pause {...stroked} size={size} className={className} aria-hidden />;
}

/** Maps to SF-style curved “return” from fullscreen player. */
export function LucideTrackGoBackIcon({ size = 21, className }: PlaybackIconBase) {
  return <CornerUpLeft {...stroked} size={size} className={className} aria-hidden />;
}
