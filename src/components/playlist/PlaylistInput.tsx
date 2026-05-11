"use client";

import { useState } from "react";
import { motion } from "framer-motion";

interface PlaylistInputProps {
  onSubmit: (input: string) => void;
  loading?: boolean;
  error?: string | null;
  compact?: boolean;
}

const EXAMPLE =
  "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M";

export default function PlaylistInput({
  onSubmit,
  loading = false,
  error = null,
  compact = false,
}: PlaylistInputProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <motion.form
      onSubmit={handleSubmit}
      className={`playlist-input ${compact ? "playlist-input--compact" : ""}`}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="playlist-input__field">
        <input
          type="text"
          inputMode="url"
          placeholder="Paste a Spotify playlist link or <iframe> embed…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" disabled={loading || !value.trim()}>
          {loading ? "Loading…" : "Load Playlist"}
        </button>
      </div>
      {!compact && (
        <div className="playlist-input__hint">
          Try this one: <code>{EXAMPLE}</code>
        </div>
      )}
      {error && <div className="playlist-input__error">{error}</div>}
    </motion.form>
  );
}
