/**
 * Extracts a Spotify playlist ID from any of the supported input formats:
 *  - Raw ID:                   37i9dQZF1DXcBWIGoYBM5M
 *  - spotify: URI:             spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
 *  - Web URL:                  https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc
 *  - Embed URL:                https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M
 *  - Full <iframe> embed code: <iframe src="https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M"></iframe>
 */
export function extractPlaylistId(input: string): string | null {
  if (!input) return null;
  const raw = input.trim();

  // Full iframe embed — pull out the src attribute first.
  const iframeMatch = raw.match(/<iframe[^>]*src=["']([^"']+)["']/i);
  if (iframeMatch) {
    const fromIframe = extractPlaylistId(iframeMatch[1]);
    if (fromIframe) return fromIframe;
  }

  // spotify:playlist:xxxx URI
  const uriMatch = raw.match(/spotify:playlist:([A-Za-z0-9]+)/i);
  if (uriMatch) return uriMatch[1];

  // https://open.spotify.com/playlist/xxxx or /embed/playlist/xxxx
  const urlMatch = raw.match(/playlist\/([A-Za-z0-9]+)/i);
  if (urlMatch) return urlMatch[1];

  // Bare id — Spotify IDs are 22-char base62 but we accept anything that
  // matches the shape to be forgiving with copy/paste.
  const bareMatch = raw.match(/^[A-Za-z0-9]{10,}$/);
  if (bareMatch) return raw;

  return null;
}
