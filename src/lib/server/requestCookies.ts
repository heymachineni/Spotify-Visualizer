/**
 * Read a named cookie from a standard Request. Matches behavior used
 * in /api/auth/token (decodeURIComponent of the value).
 */
export function getRequestCookie(
  request: Request,
  name: string
): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const parts = header.split(";");
  const prefix = `${name}=`;
  for (const part of parts) {
    const t = part.trim();
    if (t.startsWith(prefix)) {
      const raw = t.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}
