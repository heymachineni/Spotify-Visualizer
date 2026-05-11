"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Playlist } from "@/lib/types";
import type { UserLibraryResponse } from "@/lib/userLibraryTypes";
import { SVP_PLAYLIST_LIKED_ID, SVP_PLAYLIST_RECENT_ID } from "@/lib/spotifyUserIds";
import UserAvatar from "@/components/overlay/UserAvatar";
import PlaylistInput from "@/components/playlist/PlaylistInput";
import { ChevronDown16 } from "@/components/icons/ChevronDown16";
import { useAutoHideOnScroll } from "@/hooks/useAutoHideOnScroll";

type RowProps = {
  title: string;
  coverUrl: string | null;
  active: boolean;
  loading?: boolean;
  onClick: () => void;
  placeholderClass?: string;
  disabled?: boolean;
};

function LibraryRow({
  title,
  coverUrl,
  active,
  loading,
  onClick,
  placeholderClass = "",
  disabled = false,
}: RowProps) {
  return (
    <li>
      <button
        type="button"
        className={`user-lib__row${active ? " user-lib__row--active" : ""}${
          disabled ? " user-lib__row--disabled" : ""
        }`}
        onClick={onClick}
        aria-current={active ? "true" : "false"}
        disabled={loading || disabled}
      >
        <span className="user-lib__cover-wrap" aria-hidden>
          {coverUrl ? (
            <img
              className="user-lib__cover"
              src={coverUrl}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <span className={`user-lib__cover user-lib__cover--ph ${placeholderClass}`} />
          )}
        </span>
        <span className="user-lib__row-title">{title}</span>
        <span className="user-lib__radio" aria-hidden>
          {active ? "●" : "○"}
        </span>
        {loading ? <span className="user-lib__spin" /> : null}
      </button>
    </li>
  );
}

function EllipsisVerticalIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width={18}
      height={18}
      aria-hidden
    >
      <circle cx={8} cy={4} r={1.4} fill="currentColor" />
      <circle cx={8} cy={8} r={1.4} fill="currentColor" />
      <circle cx={8} cy={12} r={1.4} fill="currentColor" />
    </svg>
  );
}

export interface UserLibrarySheetProps {
  /** When true, sits in the bottom dock (no centered fixed position, no auto-hide). */
  dockEmbedded?: boolean;
  userLibrary: UserLibraryResponse | null;
  /** True while the initial `/library` call is in flight. */
  libraryLoading: boolean;
  activePlaylistId: string | null;
  /** Injected into the list while a user playlist is loading. */
  fetchingSpotifyId: string | null;
  onApplyPlaylist: (playlist: Playlist) => void;
  /** Load a user-owned playlist by Spotify id. Return true on success. */
  onSelectUserPlaylist: (id: string) => Promise<boolean>;
  /** Must resolve once the URL submission finishes (closes add UI). */
  onAddByUrl: (input: string) => Promise<Playlist | null | void>;
  addLoading: boolean;
  addError: string | null;
  /** Clears server auth cookies and should end on navigation to `/`. */
  onLogout?: () => Promise<void>;
}

export default function UserLibrarySheet({
  dockEmbedded = false,
  userLibrary,
  libraryLoading,
  activePlaylistId,
  fetchingSpotifyId,
  onApplyPlaylist,
  onSelectUserPlaylist,
  onAddByUrl,
  addLoading,
  addError,
  onLogout,
}: UserLibrarySheetProps) {
  const hidden = useAutoHideOnScroll({ disabled: dockEmbedded });
  const [open, setOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [logoutBusy, setLogoutBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const profile = userLibrary?.profile;

  const pickVirtual = (which: "liked" | "recent") => {
    if (!userLibrary) return;
    if (which === "recent" && userLibrary.recent) {
      onApplyPlaylist(userLibrary.recent);
      setOpen(false);
    }
    if (which === "liked" && userLibrary.liked) {
      onApplyPlaylist(userLibrary.liked);
      setOpen(false);
    }
  };

  const pickUser = async (id: string) => {
    const ok = await onSelectUserPlaylist(id);
    if (ok) setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!accountMenuRef.current?.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAccountMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountMenuOpen]);

  useEffect(() => {
    if (!open) setAccountMenuOpen(false);
  }, [open]);

  const handleAdd = async (input: string) => {
    const p = await onAddByUrl(input);
    if (p) setOpen(false);
  };

  const handleLogoutClick = async () => {
    if (!onLogout || logoutBusy) return;
    setLogoutBusy(true);
    setAccountMenuOpen(false);
    setOpen(false);
    try {
      await onLogout();
    } finally {
      setLogoutBusy(false);
    }
  };

  const displayName = profile?.name ?? "Spotify";

  const dockFloat = dockEmbedded;

  const stackWrapperProps = dockFloat
    ? { className: "user-lib__dock-anchor" as const }
    : ({ style: { display: "contents" as const } } as const);

  const chromeProps = {
    onWheelCapture: (e: React.WheelEvent) => e.stopPropagation(),
    onTouchMoveCapture: (e: React.TouchEvent) => e.stopPropagation(),
  };

  const panelAndBar = (
    <div {...stackWrapperProps}>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="panel"
            className={`user-lib__panel${dockFloat ? " user-lib__panel--dock-float" : ""}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="user-lib__panel-top">
              <div className="user-lib__header">
                <UserAvatar
                  name={displayName}
                  imageUrl={profile?.image ?? null}
                  size={40}
                />
                <div className="user-lib__header-text">
                  <div className="user-lib__header-name">
                    {libraryLoading && !profile ? "…" : displayName}
                  </div>
                  <div className="user-lib__header-subtitle">Connected with Spotify</div>
                </div>
                {onLogout ? (
                  <div className="user-lib__header-menu" ref={accountMenuRef}>
                    <button
                      type="button"
                      className="user-lib__kebab"
                      aria-label="Account menu"
                      aria-haspopup="menu"
                      aria-expanded={accountMenuOpen}
                      aria-busy={logoutBusy}
                      disabled={logoutBusy}
                      onClick={() => setAccountMenuOpen((v) => !v)}
                    >
                      <EllipsisVerticalIcon />
                    </button>
                    <AnimatePresence>
                      {accountMenuOpen && (
                        <motion.div
                          key="acct-menu"
                          className="user-lib__account-popover"
                          role="menu"
                          aria-label="Account"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{ duration: 0.15 }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="user-lib__account-item"
                            disabled={logoutBusy}
                            onClick={() => void handleLogoutClick()}
                          >
                            Log out
                          </button>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="user-lib__inner">
              {libraryLoading && !userLibrary ? (
                <p className="user-lib__hint">Loading your library…</p>
              ) : null}

              <section className="user-lib__section">
                <h3 className="user-lib__section-title">Shortcuts</h3>
                <ul className="user-lib__list">
                  <LibraryRow
                    title="Recently Played"
                    coverUrl={userLibrary?.recent?.tracks[0]?.albumCover ?? null}
                    active={activePlaylistId === SVP_PLAYLIST_RECENT_ID}
                    loading={false}
                    onClick={() => pickVirtual("recent")}
                    placeholderClass="user-lib__cover--recent"
                    disabled={!userLibrary?.recent}
                  />
                  <LibraryRow
                    title="Liked Songs"
                    coverUrl={userLibrary?.liked?.tracks[0]?.albumCover ?? null}
                    active={activePlaylistId === SVP_PLAYLIST_LIKED_ID}
                    loading={false}
                    onClick={() => pickVirtual("liked")}
                    placeholderClass="user-lib__cover--liked"
                    disabled={!userLibrary?.liked}
                  />
                </ul>
              </section>

              {userLibrary && userLibrary.playlists.length > 0 ? (
                <section className="user-lib__section">
                  <h3 className="user-lib__section-title">Your playlists</h3>
                  <ul className="user-lib__list">
                    {userLibrary.playlists.map((p) => (
                      <LibraryRow
                        key={p.id}
                        title={p.name}
                        coverUrl={p.coverImage}
                        active={activePlaylistId === p.id}
                        loading={fetchingSpotifyId === p.id}
                        onClick={() => void pickUser(p.id)}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              <div className="user-lib__add">
                <div className="user-lib__add-label">Add by link</div>
                <PlaylistInput
                  onSubmit={handleAdd}
                  loading={addLoading}
                  error={addError}
                  compact
                />
              </div>

              <p className="user-lib__disclaimer">
                Some content may not appear here. <br />
                Podcasts, shows, and some Spotify playlists aren’t supported
                yet. <br />
                <strong>Your own playlists will work smoothly.</strong>
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="user-lib__bar">
        <UserAvatar name={displayName} imageUrl={profile?.image ?? null} size={26} />
        <button
          type="button"
          className="user-lib__trigger"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="user-lib__trigger-label">Your playlists</span>
          <span className="user-lib__trigger-chev" aria-hidden>
            <ChevronDown16 width={15} height={15} />
          </span>
        </button>
      </div>
    </div>
  );

  if (dockEmbedded) {
    return (
      <div
        ref={cardRef}
        className="user-lib user-lib--dock"
        {...chromeProps}
      >
        {panelAndBar}
      </div>
    );
  }

  return (
    <motion.div
      ref={cardRef}
      className="user-lib"
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
      {panelAndBar}
    </motion.div>
  );
}
