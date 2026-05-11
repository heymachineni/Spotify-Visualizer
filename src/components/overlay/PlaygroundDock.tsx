"use client";

import type {
  GalleryVisualStyle,
  NormalizedTrack,
  Playlist,
} from "@/lib/types";
import UserLibrarySheet from "@/components/overlay/UserLibrarySheet";
import ControlCard from "@/components/overlay/ControlCard";
import DockNowPlaying from "@/components/overlay/DockNowPlaying";
import type { UserProductType } from "@/components/player/PlaybackManager";
import type { UserLibraryResponse } from "@/lib/userLibraryTypes";

const PRESETS: {
  id: GalleryVisualStyle;
  label: string;
  hint: string;
}[] = [
  { id: "orbit", label: "Orbit", hint: "3D drift · WebGL" },
  {
    id: "elastic_lag",
    label: "Elastic",
    hint: "Elastic grid scroll · Codrops-inspired",
  },
];

/** Bottom-dock playback strip — must stay in sync between premium & preview tiers. */
export interface PlaygroundDockPlayback {
  track: NormalizedTrack;
  paused: boolean;
  canSkipQueue: boolean;
  onOpenTrackView: () => void;
  onTogglePlay: () => void | Promise<void>;
  onPrev: () => void;
  onNext: () => void;
}

export interface PlaygroundDockProps {
  galleryStyle: GalleryVisualStyle;
  onGalleryStyleChange: (v: GalleryVisualStyle) => void;
  userProductType: UserProductType;
  dockPlayback?: PlaygroundDockPlayback | null;
  /* Premium branch */
  userLibrary?: UserLibraryResponse | null;
  libraryLoading?: boolean;
  activePlaylistId: string | null;
  fetchingSpotifyId?: string | null;
  onApplyPlaylist?: (p: Playlist) => void;
  onSelectUserPlaylist?: (id: string) => Promise<boolean>;
  onAddByUrl?: (input: string) => Promise<Playlist | null | void>;
  addLoading?: boolean;
  addError?: string | null;
  /* Preview branch */
  playlists?: Playlist[];
  onPlaylistSelect?: (id: string) => void;
  onAddPlaylist?: (input: string) => Promise<Playlist | null | void>;
  onRemovePlaylist?: (id: string) => void;
  controlLoading?: boolean;
  controlError?: string | null;
  /** Premium: clears Spotify session and returns visitor to landing. */
  onLogout?: () => Promise<void>;
}

export default function PlaygroundDock({
  galleryStyle,
  onGalleryStyleChange,
  userProductType,
  dockPlayback = null,
  userLibrary = null,
  libraryLoading = false,
  activePlaylistId,
  fetchingSpotifyId = null,
  onApplyPlaylist,
  onSelectUserPlaylist,
  onAddByUrl,
  addLoading = false,
  addError = null,
  playlists = [],
  onPlaylistSelect,
  onAddPlaylist,
  onRemovePlaylist,
  controlLoading,
  controlError,
  onLogout,
}: PlaygroundDockProps) {
  return (
    <div className="playground-dock">
      <div className="playground-dock__left">
        {userProductType === "premium" &&
        onApplyPlaylist &&
        onSelectUserPlaylist &&
        onAddByUrl ? (
          <UserLibrarySheet
            dockEmbedded
            userLibrary={userLibrary}
            libraryLoading={libraryLoading}
            activePlaylistId={activePlaylistId}
            fetchingSpotifyId={fetchingSpotifyId}
            onApplyPlaylist={onApplyPlaylist}
            onSelectUserPlaylist={onSelectUserPlaylist}
            onAddByUrl={onAddByUrl}
            addLoading={addLoading}
            addError={addError}
            onLogout={onLogout}
          />
        ) : (
          onPlaylistSelect &&
          onAddPlaylist &&
          onRemovePlaylist && (
            <ControlCard
              dockEmbedded
              playlists={playlists}
              activePlaylistId={activePlaylistId}
              onSelect={onPlaylistSelect}
              onAddPlaylist={onAddPlaylist}
              onRemovePlaylist={onRemovePlaylist}
              loading={controlLoading}
              error={controlError}
            />
          )
        )}
      </div>

      <div className="playground-dock__center">
        {dockPlayback ? (
          <DockNowPlaying
            track={dockPlayback.track}
            paused={dockPlayback.paused}
            canSkip={dockPlayback.canSkipQueue}
            onOpenTrackView={dockPlayback.onOpenTrackView}
            onTogglePlay={dockPlayback.onTogglePlay}
            onPrevious={dockPlayback.onPrev}
            onNext={dockPlayback.onNext}
          />
        ) : null}
      </div>

      <div className="playground-dock__modes" role="toolbar" aria-label="Visualizer style">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`playground-dock__mode${
              galleryStyle === p.id ? " playground-dock__mode--active" : ""
            }`}
            onClick={() => onGalleryStyleChange(p.id)}
            title={p.hint}
            aria-pressed={galleryStyle === p.id}
          >
            <span className="playground-dock__mode-label">{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
