/**
 * Preview-mode playlist fetch endpoint.
 *
 * This route is authentication-agnostic: it never reads the
 * `svp_access_token` cookie and never uses any user-scoped access token.
 * It exclusively uses the app-level **Client Credentials** token via
 * `getSpotifyAccessToken()` (plus the public embed/oEmbed fallbacks).
 * That means preview mode keeps working even when the user has
 * previously logged in with Spotify — the login cookie is simply
 * ignored here.
 */
import { NextResponse } from "next/server";
import { extractPlaylistId } from "@/lib/extractPlaylistId";
import { fetchPlaylist } from "@/lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const input = searchParams.get("input") ?? searchParams.get("id") ?? "";
  const previewEmbedOnly =
    searchParams.get("previewEmbedOnly") === "1" ||
    searchParams.get("previewFast") === "1";
  return handle(input, previewEmbedOnly);
}

export async function POST(request: Request) {
  let input = "";
  let previewEmbedOnly = false;
  try {
    const body = await request.json();
    input = String(body?.input ?? body?.id ?? "");
    previewEmbedOnly = Boolean(body?.previewEmbedOnly);
  } catch {
    // swallow — handled below
  }
  return handle(input, previewEmbedOnly);
}

async function handle(input: string, previewEmbedOnly = false) {
  if (!input) {
    return NextResponse.json(
      { error: "Missing `input` (playlist URL, URI, or ID)." },
      { status: 400 }
    );
  }

  const id = extractPlaylistId(input);
  if (!id) {
    return NextResponse.json(
      { error: "Could not extract a Spotify playlist ID from the input." },
      { status: 400 }
    );
  }

  try {
    const playlist = await fetchPlaylist(id, { previewEmbedOnly });
    return NextResponse.json({ playlist });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /Missing SPOTIFY_/i.test(message) ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
