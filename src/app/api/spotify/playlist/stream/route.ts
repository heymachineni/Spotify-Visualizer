/**
 * Streaming playlist fetch. Returns `application/x-ndjson` where each
 * line is a JSON event:
 *
 *   { "phase": "meta",  "total": 1250, "name": "…", "coverImage": "…" }
 *   { "phase": "track", "done": 1,    "total": 1250 }
 *   { "phase": "track", "done": 2,    "total": 1250 }
 *   …
 *   { "phase": "done",  "playlist": { …full normalized Playlist… } }
 *   or  { "phase": "error", "message": "…" }
 *
 * Consumed by `useSpotifyPlaylist()` so the landing screen can
 * render progress. Preview (`previewEmbedOnly`) sends `meta` then a single
 * `track` completion line; Premium / full hydrate streams per-track ticks.
 *
 * Like `/api/spotify/playlist`, this route is authentication-agnostic:
 * it uses the app-level Client Credentials token plus the public
 * embed/oEmbed fallbacks. It never reads the `svp_access_token`
 * cookie, so preview mode keeps working even when a login cookie
 * exists.
 *
 * Body `{ previewEmbedOnly: true, tracksFromEmbedOnly: true }` loads metadata +
 * tracks from the public embed page only (no `GET /v1/playlists/{id}` / Web API
 * track paging). Fails with a stable token for private / region-blocked lists.
 */
import { extractPlaylistId } from "@/lib/extractPlaylistId";
import { fetchPlaylist, type FetchPlaylistProgress } from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let input = "";
  let previewEmbedOnly = false;
  let tracksFromEmbedOnly = false;
  try {
    const body = await request.json();
    input = String(body?.input ?? body?.id ?? "");
    previewEmbedOnly = Boolean(body?.previewEmbedOnly);
    tracksFromEmbedOnly = Boolean(body?.tracksFromEmbedOnly);
    if (tracksFromEmbedOnly) previewEmbedOnly = true;
  } catch {
    // handled below
  }

  if (!input) {
    return jsonError("Missing `input` (playlist URL, URI, or ID).", 400);
  }

  const id = extractPlaylistId(input);
  if (!id) {
    return jsonError(
      "Could not extract a Spotify playlist ID from the input.",
      400
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // consumer went away — swallow so the pipeline unwinds.
        }
      };

      const onProgress = (evt: FetchPlaylistProgress) => send(evt);

      try {
        const playlist = await fetchPlaylist(id, {
          onProgress,
          previewEmbedOnly,
          tracksFromEmbedOnly,
        });
        send({ phase: "done", playlist });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        send({ phase: "error", message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      // NDJSON so a simple line-splitting client reader Just Works.
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
