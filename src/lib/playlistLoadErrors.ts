/**
 * Stable code for “public embed can’t see this playlist” — mapped to copy in UI.
 * Private, friends-only, region-locked, or otherwise non-embeddable lists.
 */
export const SVP_PLAYLIST_NOT_PUBLIC = "SVP_PLAYLIST_NOT_PUBLIC";

export function friendlyPlaylistEmbedError(raw: string): string {
  if (
    raw === SVP_PLAYLIST_NOT_PUBLIC ||
    raw.includes(SVP_PLAYLIST_NOT_PUBLIC)
  ) {
    return "This playlist isn’t available here — it may be private, friends-only, or blocked in your region. Add a public playlist instead.";
  }
  if (/Could not load playlist embed page/i.test(raw)) {
    return friendlyPlaylistEmbedError(SVP_PLAYLIST_NOT_PUBLIC);
  }
  return raw;
}
