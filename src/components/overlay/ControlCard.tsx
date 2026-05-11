"use client";

/**
 * ControlCard — a single bottom-centered floating surface that holds all
 * playlist management controls:
 *
 *   🪩  Playlist ▼
 *
 * Clicking `Playlist ▼` opens an upward-expanding dropdown that lists the
 * currently loaded playlists (click to switch, × to remove when more
 * than one exists) and exposes a compact `PlaylistInput` for adding new
 * playlists via URL or embed snippet.
 *
 * The card auto-hides while the user is scrolling the visualizer (wheel
 * / touchmove) and reappears on any subsequent pointer interaction — so
 * it never gets in the way of the 3D interaction but is always one
 * movement away.
 */

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Playlist } from "@/lib/types";
import PlaylistInput from "@/components/playlist/PlaylistInput";
import { ChevronDown16 } from "@/components/icons/ChevronDown16";
import { useAutoHideOnScroll } from "@/hooks/useAutoHideOnScroll";

interface ControlCardProps {
  /** When true, sits in the bottom dock (no centered fixed position). */
  dockEmbedded?: boolean;
  playlists: Playlist[];
  activePlaylistId: string | null;
  onSelect: (id: string) => void;
  /** Must resolve once the submission completes so the dropdown can close. */
  onAddPlaylist: (input: string) => Promise<Playlist | null | void>;
  onRemovePlaylist: (id: string) => void;
  loading?: boolean;
  error?: string | null;
}

export default function ControlCard({
  dockEmbedded = false,
  playlists,
  activePlaylistId,
  onSelect,
  onAddPlaylist,
  onRemovePlaylist,
  loading,
  error,
}: ControlCardProps) {
  const hidden = useAutoHideOnScroll({ disabled: dockEmbedded });
  // Auto-open when empty so first-time users land directly on the "paste
  // a playlist" affordance instead of hunting for it.
  const [open, setOpen] = useState(playlists.length === 0);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Close dropdown on outside pointerdown.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const node = cardRef.current;
      if (!node) return;
      if (!node.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const canRemove = playlists.length > 1;

  const handleAdd = async (input: string) => {
    const result = await onAddPlaylist(input);
    if (result) setOpen(false);
  };

  const dockFloat = dockEmbedded;
  const stackWrapperProps = dockFloat
    ? { className: "control-card__dock-anchor" as const }
    : ({ style: { display: "contents" as const } } as const);

  const menuAndBar = (
    <div {...stackWrapperProps}>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="menu"
            className={`control-card__menu${
              dockFloat ? " control-card__menu--dock-float" : ""
            }`}
            role="menu"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            {playlists.length > 0 && (
              <ul className="control-card__list">
                {playlists.map((p) => (
                  <li
                    key={p.id}
                    className={`control-card__item ${
                      p.id === activePlaylistId
                        ? "control-card__item--active"
                        : ""
                    }`}
                  >
                    <button
                      type="button"
                      className="control-card__item-main"
                      onClick={() => {
                        onSelect(p.id);
                        setOpen(false);
                      }}
                    >
                      <span className="control-card__item-name">{p.name}</span>
                      <span className="control-card__item-count">
                        {p.tracks.length}
                      </span>
                    </button>
                    {canRemove && (
                      <button
                        type="button"
                        className="control-card__item-remove"
                        onClick={() => onRemovePlaylist(p.id)}
                        aria-label={`Remove ${p.name}`}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="control-card__add">
              <div className="control-card__add-label">
                {playlists.length === 0
                  ? "Paste a Spotify playlist link or embed to begin"
                  : "Add another playlist"}
              </div>
              <PlaylistInput
                onSubmit={handleAdd}
                loading={loading}
                error={error}
                compact
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="control-card__bar">
        {!dockEmbedded && (
          <div className="control-card__logo" aria-hidden>
            🪩
          </div>
        )}
        <button
          type="button"
          className="control-card__trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span>Playlist</span>
          <span className="control-card__trigger-chev" aria-hidden>
            <ChevronDown16 width={15} height={15} />
          </span>
        </button>
      </div>
    </div>
  );

  const chromeProps = {
    onWheelCapture: (e: React.WheelEvent) => e.stopPropagation(),
    onTouchMoveCapture: (e: React.TouchEvent) => e.stopPropagation(),
  };

  if (dockEmbedded) {
    return (
      <div
        ref={cardRef}
        className="control-card control-card--dock"
        {...chromeProps}
      >
        {menuAndBar}
      </div>
    );
  }

  return (
    <motion.div
      ref={cardRef}
      className="control-card"
      // Framer sets `transform` for y/opacity; keep x: "-50%" in sync with
      // .control-card { left: 50% } so the translateX(-50%) centering is not
      // overwritten (otherwise the bar drifts off-center).
      initial={{ opacity: 0, y: 30, x: "-50%" }}
      animate={{
        opacity: hidden && !open ? 0 : 1,
        y: hidden && !open ? 24 : 0,
        x: "-50%",
        pointerEvents: hidden && !open ? "none" : "auto",
      }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      {...chromeProps}
    >
      {menuAndBar}
    </motion.div>
  );
}
