# Spotify Visual Playground

An interactive visual music playground that turns any Spotify playlist into a
WebGL universe. Album covers drift behind you as instanced 3D planes; when you
click a track, the whole interface distorts into a focal album with infinite
scrolling text columns and a sideways queue of upcoming tracks.

Demo:
https://github.com/user-attachments/assets/1980af52-b36e-45ca-82ee-1079eb350b9d

Built on top of two open source visual systems:

- **Background / default visual** — adapted from
  [J0SUKE/spotify-visualiser](https://github.com/J0SUKE/spotify-visualiser)
  (Three.js InstancedMesh + custom shaders).
- **Track-mode distortion** — adapted from
  [JorgeCapillo/infinite-scrolling-text-distortion](https://github.com/JorgeCapillo/infinite-scrolling-text-distortion)
  (sin/cos curve distortion + infinite scroll).

Both systems were analyzed, their rendering/animation cores extracted, and
refactored into modular React components — not rewritten from scratch.

## Tech stack

- Next.js 14 (App Router) + TypeScript
- React 18
- Framer Motion for UI transitions
- Three.js for the WebGL visualizer
- Raw DOM/CSS transforms for the distortion effect
- Spotify Web API (Client Credentials Flow)
- Spotify iFrame Embed API for playback

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create .env.local from the example and fill in your credentials.
#    Get a client id + secret by creating an app at
#    https://developer.spotify.com/dashboard
cp .env.local.example .env.local

# 3. Run the dev server
npm run dev
```

Then open [http://127.0.0.1:3000](http://127.0.0.1:3000) (use this exact hostname — Spotify OAuth cookies are scoped per-host, and `localhost` and `127.0.0.1` are treated as different origins) and paste either:

- A Spotify playlist URL: `https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M`
- A Spotify URI: `spotify:playlist:37i9dQZF1DXcBWIGoYBM5M`
- A full `<iframe>` embed snippet copied from the Spotify "Share → Embed playlist" menu.

## Environment variables

Put these in `.env.local` (never commit them):

```env
SPOTIFY_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SPOTIFY_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

These are used server-side only (inside `/api/spotify/playlist`). The browser
never sees them.

## Architecture

```
src/
├── app/
│   ├── api/spotify/playlist/route.ts  ← Client Credentials token + playlist fetch
│   ├── layout.tsx
│   └── page.tsx                       ← Orchestrates visual state machine
│
├── components/
│   ├── visualizer/
│   │   ├── SpotifyVisualizer.tsx      ← React port of canvas.ts + main.ts
│   │   ├── Planes.ts                  ← Port of planes.ts (InstancedMesh)
│   │   └── shaders.ts                 ← vertex.glsl + fragment.glsl as strings
│   │
│   ├── effects/
│   │   ├── TrackDistortion.tsx        ← Composite "track mode" visual
│   │   ├── DistortionColumn.tsx       ← Port of column.js (sin/cos curve)
│   │   └── QueueScroller.tsx          ← Port of images.js (sideways)
│   │
│   ├── player/
│   │   └── SpotifyEmbedPlayer.tsx     ← Wrapper around Spotify iFrame API
│   │
│   └── playlist/
│       ├── PlaylistInput.tsx
│       ├── PlaylistGallery.tsx
│       ├── AlbumCard.tsx
│       └── PlaylistSidebar.tsx
│
├── hooks/
│   ├── useSpotifyPlaylist.ts          ← client-side fetch wrapper
│   └── useSpotifyAuth.ts              ← placeholder for future PKCE flow
│
├── lib/
│   ├── extractPlaylistId.ts           ← parses URL / URI / <iframe> formats
│   ├── spotify.ts                     ← Client Credentials + playlist normalization
│   └── types.ts
│
└── styles/
    └── globals.css
```

### Visual state machine

A single React state drives everything:

```ts
type VisualMode = "default" | "track";
```

- **default** — The WebGL visualizer renders behind the UI, and the album
  gallery is shown. The embedded Spotify player is hidden.
- **track** — The visualizer dims to 35 % opacity, `TrackDistortion` fades in
  with the selected album as focal element, the embedded player becomes
  visible and calls `play()` via the iFrame API, and the sideways queue
  scroller shows upcoming songs.

Pressing **Esc** (or clicking "← Back to gallery") returns to default mode and
pauses playback.

## How the visual systems were integrated

### Visualizer (J0SUKE/spotify-visualiser)

The original repo is a single-page Three.js app with a `Canvas` class that
owns the renderer and a `Planes` class that owns an `InstancedMesh` of 400
album covers with a custom vertex/fragment shader.

What I extracted:

| Original file          | Ported to                                     |
| ---------------------- | --------------------------------------------- |
| `src/main.ts`          | `SpotifyVisualizer.tsx` (RAF loop)            |
| `src/canvas.ts`        | `SpotifyVisualizer.tsx` (scene + renderer)    |
| `src/planes.ts`        | `components/visualizer/Planes.ts`             |
| `src/shaders/*.glsl`   | `components/visualizer/shaders.ts`            |

Changes made:

- Removed `lil-gui` and `OrbitControls` dependencies.
- Dropped the hardcoded `/covers/image_{n}.jpg` list — `Planes.loadTextureAtlas(urls)`
  now accepts any list of cover URLs and rebuilds the atlas on demand.
- Added a `dispose()` method that tears down the renderer, geometry, material,
  textures, and all event listeners on unmount.
- Made pointer and wheel handling compatible with React lifecycles.

The GLSL shaders themselves were **not rewritten**.

### Distortion effect (JorgeCapillo/infinite-scrolling-text-distortion)

The original is a DOM-based demo that animates paragraphs with
`translateX(sin(progress * PI + t) * amp)` and infinite wrap-around scroll.

What I extracted:

| Original file                   | Ported to                              |
| ------------------------------- | -------------------------------------- |
| `src/js/components/column.js`   | `components/effects/DistortionColumn.tsx` |
| `src/js/components/images.js`   | `components/effects/QueueScroller.tsx`    |

The core `curve()`, item wrap-around, and easing logic is preserved 1:1 —
only adapted to React lifecycles and dynamic line data from the currently
playing track's metadata.

## Notes & caveats

- Spotify CDN images (`i.scdn.co`) send `Access-Control-Allow-Origin: *`, so
  the WebGL atlas can sample them directly. If that ever changes, the atlas
  falls back to an untainted placeholder for affected covers.
- The Spotify iFrame Embed API is loaded lazily on first mount of
  `SpotifyEmbedPlayer`. Playback requires a user interaction (clicking a
  track counts) — browsers block autoplay otherwise.
- The Client Credentials Flow can only read public playlist data. User
  playlists behind login require the Authorization Code / PKCE flow; the
  `useSpotifyAuth` hook is a placeholder where that can be plugged in later.

## Scripts

```bash
npm run dev     # start dev server on :3000
npm run build   # production build
npm run start   # run production build
npm run lint    # next lint
```

## Credits

- Visualizer: [J0SUKE/spotify-visualiser](https://github.com/J0SUKE/spotify-visualiser)
- Distortion: [JorgeCapillo/infinite-scrolling-text-distortion](https://github.com/JorgeCapillo/infinite-scrolling-text-distortion)
- Cover texture: `public/visualizer/spt-3.png` is © J0SUKE, included for parity with the original shader.
