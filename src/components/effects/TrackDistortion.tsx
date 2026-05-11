"use client";

/**
 * TrackDistortion — "track mode" visual storytelling layout.
 *
 * Layers (back → front):
 *   1. The always-on `SpotifyVisualizer` canvas (not rendered here).
 *   2. A frosted glass overlay so the visualizer reads as atmosphere.
 *   3. Two infinite-scrolling album columns that reuse the exact scroll
 *      math from JorgeCapillo/infinite-scrolling-text-distortion. Each
 *      column is fed a *circular* slice of the playlist (see `page.tsx`).
 *   4. A minimal, vertically-centered center block that shows only the
 *      currently playing track's album cover, title, and artist.
 */

import Image from "next/image";
import { motion } from "framer-motion";
import type { NormalizedTrack } from "@/lib/types";
import { LucideTrackGoBackIcon } from "@/components/media/lucidePlayback";
import DistortionAlbumColumn from "./DistortionAlbumColumn";

interface TrackDistortionProps {
  track: NormalizedTrack;
  /** Circular ring read backward from the current track (newest-previous first). */
  previous: NormalizedTrack[];
  /** Circular ring read forward from the current track (next track first). */
  upcoming: NormalizedTrack[];
  onQueueClick?: (track: NormalizedTrack) => void;
  /** Returns to playground view — does not stop Spotify playback. */
  onLeaveBack?: () => void;
}

export default function TrackDistortion({
  track,
  previous,
  upcoming,
  onQueueClick,
  onLeaveBack,
}: TrackDistortionProps) {
  return (
    <motion.div
      className="track-mode"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="track-mode__glass" aria-hidden />

      <div className="track-mode__side track-mode__side--left">
        <DistortionAlbumColumn
          tracks={previous}
          reverse={false}
          defaultSpeed={0.45}
          onTrackClick={onQueueClick}
        />
      </div>

      <motion.div
        key={track.id}
        className="track-mode__center"
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        {onLeaveBack && (
          <button
            type="button"
            className="track-mode__back"
            onClick={onLeaveBack}
            aria-label="Go back"
            data-ui-tip="Go back"
          >
            <span className="track-mode__back-icon-wrap" aria-hidden>
              <LucideTrackGoBackIcon size={21} />
            </span>
          </button>
        )}
        <div className="track-mode__album-frame">
          {track.albumCover ? (
            <Image
              src={track.albumCover}
              alt={track.title}
              width={720}
              height={720}
              unoptimized
              priority
              draggable={false}
            />
          ) : null}
        </div>
        <h1 className="track-mode__title" title={track.title}>
          {track.title}
        </h1>
        <p className="track-mode__artist">{track.artist}</p>
      </motion.div>

      <div className="track-mode__side track-mode__side--right">
        <DistortionAlbumColumn
          tracks={upcoming}
          reverse
          defaultSpeed={0.45}
          onTrackClick={onQueueClick}
        />
      </div>
    </motion.div>
  );
}
