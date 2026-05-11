/**
 * Instanced album cards: one atlas of pre-rendered cards (cover + title +
 * artist) styled to align with Nyx UI MusicPlayer `theme="midnight"` surface
 * (slate/neutral/zinc gradient, slate border) — see nyxui.com/components/music-player.
 * GPU pick; each instance maps through a shuffled atlas row on Z wrap.
 */

import * as THREE from "three";
import {
  visualizerFragmentShader,
  visualizerPickFragmentShader,
  visualizerVertexShader,
} from "./shaders";

export interface Size {
  width: number;
  height: number;
}

export interface TrackCardInput {
  url: string;
  title: string;
  artist: string;
}

interface PlanesProps {
  scene: THREE.Scene;
  sizes: Size;
  meshCount?: number;
}

interface ImageInfo {
  width: number;
  height: number;
  uvs: { xStart: number; xEnd: number; yStart: number; yEnd: number };
}

const FALLBACK_SIZE = 512;
/** Portrait card — height chosen for tall artwork + compact text (no controls strip). */
const CARD_PX_W = 230;
const CARD_PX_H = 252;
const MAX_ATLAS_HEIGHT = 15000;

/** Z range for instance placement; must match `visualizerVertexShader` minZ / maxZ. */
const Z_BOUNDS = { max: 8, min: -18 };

/**
 * ~N(0,1); pair generation (no per-frame use — called from fillMeshData only).
 */
function randomGaussian() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function modIndex(i: number, n: number): number {
  return ((i % n) + n) % n;
}

/** Uniform random permutation of 0..n-1 (Fisher–Yates). */
function shufflePermutation(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/**
 * Rounded-rect path (Canvas roundRect or arc fallback).
 */
function pathRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (typeof (ctx as unknown as { roundRect: unknown }).roundRect === "function") {
    (ctx as unknown as { roundRect: (a: number, b: number, c: number, d: number, e: number) => void })
      .roundRect(x, y, w, h, rr);
  } else {
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
  }
  ctx.closePath();
}

type RGB = { r: number; g: number; b: number };

/**
 * sRGB 0..255 to HSL in [0,1] for h (hue wraps), s and l in [0,1].
 */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s: number;
  const l = (max + min) / 2;
  if (max === min) {
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * H in [0,1], s and l in [0,1] → sRGB 0..255
 */
function hslToRgb(h: number, s: number, l: number): RGB {
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(255 * hue2rgb(p, q, h + 1 / 3)),
    g: Math.round(255 * hue2rgb(p, q, h)),
    b: Math.round(255 * hue2rgb(p, q, h - 1 / 3)),
  };
}

/** Darken: push lightness toward black; amount 0..1, typical ~0.35–0.45. */
function darken(c: RGB, amount: number): RGB {
  const t = Math.min(1, Math.max(0, amount));
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  const l2 = l * (1 - t * 0.88);
  return hslToRgb(h, s * (1 - t * 0.15), l2);
}

/** Lighten: push lightness up; amount 0..1. */
function lighten(c: RGB, amount: number): RGB {
  const t = Math.min(1, Math.max(0, amount));
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  const l2 = l + (1 - l) * t * 0.75;
  return hslToRgb(h, s, Math.min(1, l2));
}

function toCssColor(c: RGB): string {
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

const DEFAULT_PALETTE: { primary: RGB; secondary: RGB } = {
  primary: { r: 32, g: 32, b: 40 },
  secondary: { r: 44, g: 44, b: 56 },
};

/**
 * Tame hot / muddy picks: cap saturation, keep luminance in a window for premium look.
 */
function softenAlbumColor(c: RGB): RGB {
  const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
  const s2 = Math.min(0.4, s * 0.82);
  const l2 = Math.max(0.1, Math.min(0.55, l));
  const base = hslToRgb(h, s2, l2);
  if (l2 < 0.14) return lighten(base, 0.05);
  return base;
}

/**
 * 32×32 downsample, quantized bins for primary, global mean for secondary.
 * Secondary gains contrast if too close to primary.
 */
function extractAlbumPalette(img: HTMLImageElement): { primary: RGB; secondary: RGB } {
  if (!img.naturalWidth || !img.naturalHeight) {
    return { ...DEFAULT_PALETTE, primary: { ...DEFAULT_PALETTE.primary }, secondary: { ...DEFAULT_PALETTE.secondary } };
  }
  const SZ = 32;
  const c = document.createElement("canvas");
  c.width = SZ;
  c.height = SZ;
  const cctx = c.getContext("2d");
  if (!cctx) {
    return { ...DEFAULT_PALETTE, primary: { ...DEFAULT_PALETTE.primary }, secondary: { ...DEFAULT_PALETTE.secondary } };
  }
  let id: ImageData;
  try {
    cctx.drawImage(img, 0, 0, SZ, SZ);
    id = cctx.getImageData(0, 0, SZ, SZ);
  } catch {
    return { ...DEFAULT_PALETTE, primary: { ...DEFAULT_PALETTE.primary }, secondary: { ...DEFAULT_PALETTE.secondary } };
  }
  const d = id.data;
  const bins = new Map<
    number,
    { n: number; r: number; g: number; b: number }
  >();
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    if (a < 6) continue;
    const r = d[i] ?? 0;
    const g = d[i + 1] ?? 0;
    const b = d[i + 2] ?? 0;
    const br = r >> 4;
    const bg = g >> 4;
    const bb = b >> 4;
    const key = (br << 8) | (bg << 4) | bb;
    const ex = bins.get(key);
    if (ex) {
      ex.n++;
      ex.r += r;
      ex.g += g;
      ex.b += b;
    } else {
      bins.set(key, { n: 1, r, g, b });
    }
    sumR += r;
    sumG += g;
    sumB += b;
    count++;
  }
  if (count < 1) {
    return { ...DEFAULT_PALETTE, primary: { ...DEFAULT_PALETTE.primary }, secondary: { ...DEFAULT_PALETTE.secondary } };
  }
  let best: { n: number; r: number; g: number; b: number } = { n: 0, r: 0, g: 0, b: 0 };
  for (const v of bins.values()) {
    if (v.n > best.n) best = v;
  }
  const primary: RGB = {
    r: best.r / best.n,
    g: best.g / best.n,
    b: best.b / best.n,
  };
  const avg: RGB = {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count,
  };
  const dr = primary.r - avg.r;
  const dg = primary.g - avg.g;
  const db = primary.b - avg.b;
  if (dr * dr + dg * dg + db * db < 1800) {
    const p = primary;
    const nudge: RGB = {
      r: p.r * 0.35 + p.g * 0.3 + 40,
      g: p.g * 0.35 + p.b * 0.3 + 32,
      b: p.b * 0.35 + p.r * 0.3 + 48,
    };
    nudge.r = Math.min(255, nudge.r);
    nudge.g = Math.min(255, nudge.g);
    nudge.b = Math.min(255, nudge.b);
    let secondary: RGB = avg;
    const mix = 0.55;
    secondary = {
      r: secondary.r * (1 - mix) + nudge.r * mix,
      g: secondary.g * (1 - mix) + nudge.g * mix,
      b: secondary.b * (1 - mix) + nudge.b * mix,
    };
    return {
      primary: softenAlbumColor(primary),
      secondary: softenAlbumColor(secondary),
    };
  }
  return {
    primary: softenAlbumColor(primary),
    secondary: softenAlbumColor(avg),
  };
}

/** Word-wrap the title; length ≤ maxLines. Uses current ctx font for measureText. */
function layoutFittedTitleLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number
): string[] {
  const t = text.trim() || "Untitled";
  const words = t.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (let w = 0; w < words.length; w++) {
    const test = line ? `${line} ${words[w]}` : words[w];
    if (ctx.measureText(test).width <= maxW) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = words[w];
      if (lines.length >= maxLines) break;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length > maxLines) {
    const ell = "…";
    let s = lines.slice(0, maxLines).join(" ");
    while (s.length > 1 && ctx.measureText(s + ell).width > maxW) {
      s = s.slice(0, -1);
    }
    lines.length = 0;
    lines.push(s + ell);
  }
  return lines;
}

function drawFittedTitleLines(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  cx: number,
  y0: number,
  lineH: number,
  maxW: number
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const ell = "…";
  for (let i = 0; i < lines.length; i++) {
    let s = lines[i]!;
    if (ctx.measureText(s).width > maxW) {
      while (s.length > 1 && ctx.measureText(s + ell).width > maxW) s = s.slice(0, -1);
      s += ell;
    }
    ctx.fillText(s, cx, y0 + i * lineH);
  }
}

function zPeriodForInitialZ(az: number) {
  const maxZoff = Math.abs(az - Z_BOUNDS.max);
  const minZoff = Math.abs(az - Z_BOUNDS.min);
  return { period: maxZoff + minZoff, minZoff, maxZoff };
}

function drawArtistLine(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y0: number,
  maxW: number,
  fontPx: number
) {
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `400 ${fontPx}px Inter, system-ui, sans-serif`;
  const ell = "…";
  let s = text.trim() || "—";
  if (ctx.measureText(s).width > maxW) {
    while (s.length > 1 && ctx.measureText(s + ell).width > maxW) s = s.slice(0, -1);
    s += ell;
  }
  ctx.fillStyle = "rgba(255,255,255,0.70)";
  ctx.fillText(s, cx, y0);
}

export default class Planes {
  scene: THREE.Scene;
  sizes: Size;
  geometry!: THREE.PlaneGeometry;
  material!: THREE.ShaderMaterial;
  pickMaterial!: THREE.ShaderMaterial;
  mesh!: THREE.InstancedMesh;
  meshCount: number;

  drag = {
    xCurrent: 0,
    xTarget: 0,
    yCurrent: 0,
    yTarget: 0,
    isDown: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    /** Smoothed horizontal drag velocity (world units) for throw inertia. */
    xVel: 0,
    /** Coast after pointer up; applied to xTarget, decays each frame. */
    xInertia: 0,
  };

  shaderParameters = { maxX: 0, maxY: 0 };

  scrollY = { target: 0, current: 0, direction: 0 };

  /**
   * Per instance: 0..N-1 "slot" (advances on Z wrap). Atlas row = perm[slot].
   */
  private instanceSlot: Int32Array = new Int32Array(0);
  /** Random permutation of 0..N-1, rebuilt when the atlas size changes. */
  private coverPerm: number[] = [];
  /** `floor((scrollY + minZoff) / period)` for last frame — see vertex Z math. */
  private lastZCycle: Int32Array = new Int32Array(0);
  private initialPositionZ: Float32Array = new Float32Array(0);

  dragSensitivity = 1;
  /** Lerp for vertical drag; horizontal uses dragDampingX. */
  dragDamping = 0.1;
  /** Infinite canvas follow (unbounded, no X clamp) — keep both axes in sync. */
  dragDampingX = 0.1;
  /** After release, horizontal coast decays (geometric; tuned for subtle, non-runaway drift). */
  dragInertiaDecay = 0.89;

  /**
   * When false (e.g. UI dim mode), pointer does not build `uDrag` target.
   * Does not affect scroll, picking, or instance data.
   */
  dragEnabled = true;

  dragElement: HTMLElement | null = null;
  imageInfos: ImageInfo[] = [];
  atlasTexture: THREE.Texture | null = null;
  blurryAtlasTexture: THREE.Texture | null = null;

  private instanceToCoverIndex: number[] = [];
  private textureCoordAttribute: THREE.InstancedBufferAttribute | null = null;

  private pickTarget: THREE.WebGLRenderTarget;
  private pickPixel = new Uint8Array(4);

  private pointerDown?: (e: PointerEvent) => void;
  private pointerMove?: (e: PointerEvent) => void;
  private pointerUp?: (e: PointerEvent) => void;
  private onWheelBound: (e: WheelEvent) => void;

  /** Smoothed NDC pointer (-1..1, +Y up) for GPU proximity. */
  private pointerNdc = new THREE.Vector2(0, 2);
  private pointerNdcTarget = new THREE.Vector2(0, 2);
  private pointerValid = 0;
  private pointerValidTarget = 0;
  private selectedInstanceId = -1;
  private selectStrength = 0;
  private selectTarget = 0;

  constructor({ scene, sizes, meshCount = 550 }: PlanesProps) {
    this.scene = scene;
    this.sizes = sizes;
    this.meshCount = meshCount;
    this.shaderParameters = {
      maxX: this.sizes.width * 2,
      maxY: this.sizes.height * 2,
    };

    this.pickTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });

    this.createGeometry();
    this.createMaterial();
    this.createInstancedMesh();
    this.fillInstanceIds();

    this.onWheelBound = this.onWheel.bind(this);
    window.addEventListener("wheel", this.onWheelBound, { passive: true });
  }

  updateSizes(sizes: Size) {
    this.sizes = sizes;
    this.shaderParameters = {
      maxX: sizes.width * 2,
      maxY: sizes.height * 2,
    };
    this.material.uniforms.uMaxXdisplacement.value.set(
      this.shaderParameters.maxX,
      this.shaderParameters.maxY
    );
    this.pickMaterial.uniforms.uMaxXdisplacement.value.set(
      this.shaderParameters.maxX,
      this.shaderParameters.maxY
    );
  }

  setPickTargetSize(pxWidth: number, pxHeight: number) {
    this.pickTarget.setSize(Math.max(1, pxWidth), Math.max(1, pxHeight));
  }

  createGeometry() {
    const aspect = CARD_PX_H / CARD_PX_W;
    this.geometry = new THREE.PlaneGeometry(1, aspect, 1, 1);
    this.geometry.scale(2, 2, 2);
  }

  createMaterial() {
    const sharedUniforms = {
      uTime: { value: 0 },
      uMaxXdisplacement: {
        value: new THREE.Vector2(
          this.shaderParameters.maxX,
          this.shaderParameters.maxY
        ),
      },
      uScrollY: { value: 0 },
      uSpeedY: { value: 0 },
      uDrag: { value: new THREE.Vector2(0, 0) },
      uPointerNdc: { value: new THREE.Vector2(0, 2) },
      uPointerBlend: { value: 0 },
      uSelectedId: { value: -1 },
      uSelectStrength: { value: 0 },
    };

    this.material = new THREE.ShaderMaterial({
      vertexShader: visualizerVertexShader,
      fragmentShader: visualizerFragmentShader,
      transparent: true,
      uniforms: {
        ...sharedUniforms,
        uAtlas: new THREE.Uniform<THREE.Texture | null>(null),
        uBlurryAtlas: new THREE.Uniform<THREE.Texture | null>(null),
      },
    });

    this.pickMaterial = new THREE.ShaderMaterial({
      vertexShader: visualizerVertexShader,
      fragmentShader: visualizerPickFragmentShader,
      transparent: false,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        ...sharedUniforms,
        uAtlas: new THREE.Uniform<THREE.Texture | null>(null),
      },
    });
  }

  createInstancedMesh() {
    this.mesh = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.meshCount
    );
    this.scene.add(this.mesh);
  }

  private fillInstanceIds() {
    const ids = new Float32Array(this.meshCount);
    for (let i = 0; i < this.meshCount; i++) ids[i] = i;
    this.geometry.setAttribute(
      "aInstanceId",
      new THREE.InstancedBufferAttribute(ids, 1)
    );
  }

  /**
   * Build a vertical texture atlas: each row = one card (glass + cover + title).
   */
  async loadTrackCardAtlas(items: TrackCardInput[]) {
    if (items.length === 0) return;

    const scale = Math.min(
      1,
      items.length * CARD_PX_H > MAX_ATLAS_HEIGHT
        ? MAX_ATLAS_HEIGHT / (items.length * CARD_PX_H)
        : 1
    );
    const W = Math.max(32, Math.floor(CARD_PX_W * scale));
    const H = Math.max(40, Math.floor(CARD_PX_H * scale));

    const coverPad = Math.max(5, 10 * scale);
    const coverW = W - 2 * coverPad;
    /** ~ Nyx MusicPlayer title `text-lg` / `font-bold`, artist `text-sm opacity-70`. */
    const titleFs = Math.max(13, Math.round(17 * scale));
    const artistFs = Math.max(11, Math.round(13 * scale));
    const titleLineH = Math.max(14, Math.round(17 * scale));
    const titleBlockH = titleLineH * 2;
    const labelGap = Math.max(5, 6 * scale);
    const artistGap = Math.max(3, 5 * scale);
    const textBlockH = titleBlockH + artistGap + artistFs + 2;
    const coverH = Math.max(
      24,
      Math.min(coverW, H - 2 * coverPad - labelGap - textBlockH)
    );

    const images: HTMLImageElement[] = await Promise.all(
      items.map(
        (item) =>
          new Promise<HTMLImageElement>((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.referrerPolicy = "no-referrer";
            img.onload = () => resolve(img);
            img.onerror = () => {
              const fallback = new Image();
              fallback.width = 1;
              fallback.height = 1;
              resolve(fallback);
            };
            img.src = item.url;
          })
      )
    );

    const atlasWidth = Math.max(
      FALLBACK_SIZE,
      W,
      ...images.map((img) => img.naturalWidth || img.width || 1)
    );
    const rowH = H;
    let totalHeight = items.length * rowH;

    if (totalHeight > MAX_ATLAS_HEIGHT) {
      console.warn(
        "[visualizer] atlas very tall; card scale was reduced. rows:",
        items.length
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = atlasWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, atlasWidth, totalHeight);

    let currentY = 0;
    const xOff = (atlasWidth - W) / 2;
    const out: ImageInfo[] = [];
    /** Nyx card uses `rounded-2xl` (~16px). */
    const radius = 16 * scale;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const img = images[i]!;
      const w = W;
      const h = H;
      const bgX = xOff;
      const bgY = currentY;

      ctx.save();
      pathRoundRect(ctx, bgX, bgY, w, h, radius);
      ctx.clip();

      const { primary, secondary } = extractAlbumPalette(img);

      // Nyx UI `theme="midnight"` dark surface (tailwind): `bg-gradient-to-br`
      // from-slate-900/95 via-neutral-800/95 to-zinc-900/95 — see
      // https://nyxui.com/components/music-player — plus a whisper of album tint.
      const slate900 = { r: 15, g: 23, b: 42 };
      const neutral800 = { r: 38, g: 38, b: 38 };
      const zinc900 = { r: 24, g: 24, b: 27 };
      const tintA = softenAlbumColor(primary);
      const tintB = softenAlbumColor(secondary);
      const tintW = 0.08;
      const a0 = {
        r: slate900.r * (1 - tintW) + tintA.r * tintW,
        g: slate900.g * (1 - tintW) + tintA.g * tintW,
        b: slate900.b * (1 - tintW) + tintA.b * tintW,
      };
      const a1 = {
        r: neutral800.r * (1 - tintW) + tintB.r * tintW,
        g: neutral800.g * (1 - tintW) + tintB.g * tintW,
        b: neutral800.b * (1 - tintW) + tintB.b * tintW,
      };
      const a2 = {
        r: zinc900.r * (1 - tintW) + tintB.r * tintW,
        g: zinc900.g * (1 - tintW) + tintB.g * tintW,
        b: zinc900.b * (1 - tintW) + tintB.b * tintW,
      };
      {
        const gr = ctx.createLinearGradient(bgX, bgY, bgX + w, bgY + h);
        const al = 0.95;
        const r0 = `rgba(${Math.round(a0.r)},${Math.round(a0.g)},${Math.round(a0.b)},${al})`;
        const r1 = `rgba(${Math.round(a1.r)},${Math.round(a1.g)},${Math.round(a1.b)},${al})`;
        const r2 = `rgba(${Math.round(a2.r)},${Math.round(a2.g)},${Math.round(a2.b)},${al})`;
        gr.addColorStop(0, r0);
        gr.addColorStop(0.5, r1);
        gr.addColorStop(1, r2);
        ctx.fillStyle = gr;
        ctx.fillRect(bgX, bgY, w, h);
      }

      // Soft art wash (restrained)
      try {
        const ambScale = 1.18;
        const ambW = w * ambScale;
        const ambH = h * ambScale;
        const ambX = bgX - (ambW - w) / 2;
        const ambY = bgY - (ambH - h) / 2;
        ctx.save();
        (ctx as CanvasRenderingContext2D & { filter: string }).filter =
          "blur(52px) saturate(1.08)";
        ctx.globalAlpha = 0.2;
        ctx.drawImage(img, ambX, ambY, ambW, ambH);
        ctx.restore();
      } catch {
        // non-fatal
      }
      ctx.globalAlpha = 1;
      (ctx as CanvasRenderingContext2D & { filter: string }).filter = "none";

      // Subtle vignette (lighter than before — Nyx relies on flat gradient + border)
      {
        const gcx = bgX + w / 2;
        const gcy = bgY + h / 2;
        const r0 = Math.max(w, h) * 0.2;
        const r1 = Math.max(w, h) * 0.92;
        const vig = ctx.createRadialGradient(gcx, gcy, r0, gcx, gcy, r1);
        vig.addColorStop(0, "rgba(0,0,0,0)");
        vig.addColorStop(0.65, "rgba(0,0,0,0.04)");
        vig.addColorStop(1, "rgba(0,0,0,0.18)");
        ctx.fillStyle = vig;
        ctx.fillRect(bgX, bgY, w, h);
      }

      // backdrop-blur feel: very light frost (`backdrop-blur-sm` analogue)
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(bgX, bgY, w, h);
      ctx.restore();

      pathRoundRect(ctx, bgX + 0.5, bgY + 0.5, w - 1, h - 1, radius - 0.5);
      // `border-slate-400/40`
      ctx.strokeStyle = "rgba(148,163,184,0.40)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const cX = bgX + coverPad;
      const cY = bgY + coverPad;
      ctx.save();
      pathRoundRect(ctx, cX, cY, coverW, coverH, 12 * scale);
      ctx.clip();
      try {
        ctx.drawImage(img, cX, cY, coverW, coverH);
      } catch {
        // non-fatal
      }
      ctx.restore();

      const textBandH = h - 2 * coverPad - coverH - labelGap;
      const labelY = bgY + coverPad + coverH + labelGap;
      const titleTextW = w - 2 * coverPad;
      ctx.fillStyle = "rgba(255,255,255,0.98)";
      ctx.font = `700 ${titleFs}px Inter, system-ui, sans-serif`;
      const titleLines = layoutFittedTitleLines(
        ctx,
        item.title,
        titleTextW,
        2
      );
      const actualTitleLines = titleLines.length;
      const titleHeight = actualTitleLines * titleLineH;
      const textContentH = titleHeight + artistGap + artistFs;
      const titleY =
        labelY + Math.max(0, (textBandH - textContentH) * 0.5);
      drawFittedTitleLines(
        ctx,
        titleLines,
        bgX + w / 2,
        titleY,
        titleLineH,
        titleTextW
      );
      const artistY = titleY + titleHeight + artistGap;
      drawArtistLine(
        ctx,
        item.artist,
        bgX + w / 2,
        artistY,
        titleTextW,
        artistFs
      );

      out.push({
        width: w,
        height: h,
        uvs: {
          xStart: bgX / atlasWidth,
          xEnd: (bgX + w) / atlasWidth,
          yStart: 1 - currentY / totalHeight,
          yEnd: 1 - (currentY + h) / totalHeight,
        },
      });
      currentY += h;
    }
    this.imageInfos = out;

    const atlasTexture = new THREE.Texture(canvas);
    atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
    atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
    atlasTexture.minFilter = THREE.LinearFilter;
    atlasTexture.magFilter = THREE.LinearFilter;
    atlasTexture.needsUpdate = true;
    this.atlasTexture?.dispose();
    this.atlasTexture = atlasTexture;
    this.material.uniforms.uAtlas.value = atlasTexture;
    this.pickMaterial.uniforms.uAtlas.value = atlasTexture;

    this.createBlurryAtlas(canvas);
    this.fillMeshData();
  }

  private createBlurryAtlas(source: HTMLCanvasElement) {
    const blurryCanvas = document.createElement("canvas");
    blurryCanvas.width = source.width;
    blurryCanvas.height = source.height;
    const ctx = blurryCanvas.getContext("2d")!;
    ctx.filter = "blur(72px)";
    try {
      ctx.drawImage(source, 0, 0);
    } catch {
      // non-fatal
    }
    this.blurryAtlasTexture?.dispose();
    const tex = new THREE.Texture(blurryCanvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.blurryAtlasTexture = tex;
    this.material.uniforms.uBlurryAtlas.value = tex;
  }

  private fillMeshData() {
    if (this.imageInfos.length === 0) return;

    const N = this.imageInfos.length;
    const initialPosition = new Float32Array(this.meshCount * 3);
    const meshSpeed = new Float32Array(this.meshCount);
    const aTextureCoords = new Float32Array(this.meshCount * 4);
    this.instanceToCoverIndex = new Array(this.meshCount);
    this.initialPositionZ = new Float32Array(this.meshCount);
    this.instanceSlot = new Int32Array(this.meshCount);
    this.lastZCycle = new Int32Array(this.meshCount);
    const scroll = this.scrollY.current;
    this.coverPerm = shufflePermutation(N);

    const { min: zMin, max: zMax } = Z_BOUNDS;
    const halfX = this.shaderParameters.maxX;
    const halfY = this.shaderParameters.maxY;
    const xyBias = 0.85;
    for (let i = 0; i < this.meshCount; i++) {
      let gx = randomGaussian() * halfX * xyBias;
      let gy = randomGaussian() * halfY * xyBias;
      initialPosition[i * 3 + 0] = Math.max(-halfX, Math.min(halfX, gx));
      initialPosition[i * 3 + 1] = Math.max(-halfY, Math.min(halfY, gy));
      const t = Math.pow(Math.random(), 0.6);
      initialPosition[i * 3 + 2] = zMin + (zMax - zMin) * t;

      const az = initialPosition[i * 3 + 2]!;
      this.initialPositionZ[i] = az;
      meshSpeed[i] = Math.random() * 0.5 + 0.5;

      this.instanceSlot[i] = i % N;
      const { period, minZoff } = zPeriodForInitialZ(az);
      this.lastZCycle[i] =
        period < 1e-5 ? 0 : Math.floor((scroll + minZoff) / period);
    }

    this.geometry.setAttribute(
      "aInitialPosition",
      new THREE.InstancedBufferAttribute(initialPosition, 3)
    );
    this.geometry.setAttribute(
      "aMeshSpeed",
      new THREE.InstancedBufferAttribute(meshSpeed, 1)
    );
    this.mesh.geometry.setAttribute(
      "aTextureCoords",
      new THREE.InstancedBufferAttribute(aTextureCoords, 4)
    );
    this.textureCoordAttribute = this.mesh.geometry.getAttribute(
      "aTextureCoords"
    ) as THREE.InstancedBufferAttribute;
    this.applyInstanceTrackIndicesToTextureCoords();
  }

  private applyInstanceTrackIndicesToTextureCoords() {
    if (this.imageInfos.length === 0 || !this.textureCoordAttribute) return;
    const N = this.imageInfos.length;
    const arr = this.textureCoordAttribute.array as Float32Array;
    for (let i = 0; i < this.meshCount; i++) {
      const slot = modIndex(this.instanceSlot[i]!, N);
      const imageIndex = this.coverPerm[slot]!;
      this.instanceToCoverIndex[i] = imageIndex;
      const u = this.imageInfos[imageIndex]!.uvs;
      arr[i * 4 + 0] = u.xStart;
      arr[i * 4 + 1] = u.xEnd;
      arr[i * 4 + 2] = u.yStart;
      arr[i * 4 + 3] = u.yEnd;
    }
    this.textureCoordAttribute.needsUpdate = true;
  }

  /**
   * When uScrollY advances, each instance’s `mod(…, period)` Z cycle can
   * complete — then move that instance forward in the track list.
   */
  private checkZWrapsAndAdvanceTracks() {
    if (this.imageInfos.length === 0 || !this.textureCoordAttribute) return;
    const N = this.imageInfos.length;
    const scroll = this.scrollY.current;
    let any = false;
    for (let i = 0; i < this.meshCount; i++) {
      const az = this.initialPositionZ[i]!;
      const { period, minZoff } = zPeriodForInitialZ(az);
      if (period < 1e-5) continue;
      const a = scroll + minZoff;
      const cycle = Math.floor(a / period);
      const prev = this.lastZCycle[i]!;
      const delta = cycle - prev;
      if (delta !== 0) {
        this.instanceSlot[i] = modIndex(
          this.instanceSlot[i]! + delta,
          N
        );
        this.lastZCycle[i] = cycle;
        any = true;
      }
    }
    if (any) this.applyInstanceTrackIndicesToTextureCoords();
  }

  /**
   * Which atlas row this instance is showing (0 .. N-1) — use with coverIndexMap on the
   * React side to resolve to a playlist track.
   */
  coverIndexFor(instanceId: number): number | null {
    if (instanceId < 0 || instanceId >= this.instanceToCoverIndex.length) {
      return null;
    }
    const idx = this.instanceToCoverIndex[instanceId];
    return typeof idx === "number" ? idx : null;
  }

  /**
   * Update cursor in normalized device space (-1..1, +Y up) for proximity response.
   * @param inBounds - false when the pointer has left the canvas.
   */
  setPointerNdc(
    x: number,
    y: number,
    inBounds: boolean
  ) {
    this.pointerNdcTarget.set(x, y);
    this.pointerValidTarget = inBounds ? 1 : 0;
  }

  /**
   * Highlight a picked instanced card (or clear); strength lerps in render.
   */
  setSelectedInstance(instanceId: number | null) {
    this.selectedInstanceId = instanceId == null || instanceId < 0 ? -1 : instanceId;
    this.selectTarget = instanceId == null || instanceId < 0 ? 0 : 1;
  }

  /** Enable/disable world XY pan; scroll / wrap / instancing unchanged. */
  setDragEnabled(on: boolean) {
    this.dragEnabled = on;
    if (!on) {
      this.drag.isDown = false;
    }
  }

  private syncInteractionUniforms(target: THREE.ShaderMaterial) {
    (target.uniforms.uPointerNdc.value as THREE.Vector2).copy(
      this.pointerNdc
    );
    target.uniforms.uPointerBlend.value = this.pointerValid;
    target.uniforms.uSelectedId.value = this.selectedInstanceId;
    target.uniforms.uSelectStrength.value = this.selectStrength;
  }

  private stepInteractionLerp() {
    const p = 0.14;
    this.pointerNdc.x += (this.pointerNdcTarget.x - this.pointerNdc.x) * p;
    this.pointerNdc.y += (this.pointerNdcTarget.y - this.pointerNdc.y) * p;
    this.pointerValid = interpolate(
      this.pointerValid,
      this.pointerValidTarget,
      0.12
    );
    this.selectStrength = interpolate(
      this.selectStrength,
      this.selectTarget,
      0.1
    );
  }

  bindDrag(element: HTMLElement) {
    this.dragElement = element;

    this.pointerDown = (e: PointerEvent) => {
      if (!this.dragEnabled) return;
      this.drag.isDown = true;
      this.drag.startX = e.clientX;
      this.drag.startY = e.clientY;
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
      this.drag.xVel = 0;
      this.drag.xInertia = 0;
      try {
        element.setPointerCapture(e.pointerId);
      } catch {
        /* no-op */
      }
    };

    this.pointerMove = (e: PointerEvent) => {
      if (!this.drag.isDown) return;
      if (!this.dragEnabled) return;
      const dx = e.clientX - this.drag.lastX;
      const dy = e.clientY - this.drag.lastY;
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;

      const worldPerPixelX =
        (this.sizes.width / window.innerWidth) * this.dragSensitivity;
      const worldPerPixelY =
        (this.sizes.height / window.innerHeight) * this.dragSensitivity;

      const wx = -dx * worldPerPixelX;
      this.drag.xTarget += wx;
      // Touch: no mouse wheel — vertical swipe drives depth (scrollY) like the wheel; horizontal still pans X.
      if (e.pointerType === "touch") {
        this.applyDepthScrollFromWheelDelta(dy);
      } else {
        this.drag.yTarget += dy * worldPerPixelY;
      }
      this.drag.xVel = this.drag.xVel * 0.55 + wx * 0.45;
    };

    this.pointerUp = (e: PointerEvent) => {
      this.drag.isDown = false;
      this.drag.xInertia = this.drag.xVel * 0.55;
      this.drag.xVel = 0;
      try {
        element.releasePointerCapture(e.pointerId);
      } catch {
        /* no-op */
      }
    };

    element.addEventListener("pointerdown", this.pointerDown);
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp);
  }

  /** Same mapping as `wheel` `deltaY` (positive ≈ scroll down / fingers move down). */
  applyDepthScrollFromWheelDelta(deltaY: number) {
    const scrollY = (deltaY * this.sizes.height) / window.innerHeight;
    this.scrollY.target += scrollY;
    this.material.uniforms.uSpeedY.value += scrollY;
  }

  onWheel(event: WheelEvent) {
    this.applyDepthScrollFromWheelDelta(event.deltaY);
  }

  render(delta: number) {
    this.material.uniforms.uTime.value += delta * 0.015;

    const t = Math.min(4, delta * 60);
    const inertDecay = this.dragInertiaDecay ** t;
    if (!this.drag.isDown) {
      this.drag.xTarget += this.drag.xInertia;
      this.drag.xInertia *= inertDecay;
      if (Math.abs(this.drag.xInertia) < 1e-4) {
        this.drag.xInertia = 0;
      }
    }
    this.drag.xCurrent +=
      (this.drag.xTarget - this.drag.xCurrent) * this.dragDampingX;
    this.drag.yCurrent +=
      (this.drag.yTarget - this.drag.yCurrent) * this.dragDamping;

    this.material.uniforms.uDrag.value.set(
      this.drag.xCurrent,
      this.drag.yCurrent
    );

    this.scrollY.current = interpolate(
      this.scrollY.current,
      this.scrollY.target,
      0.12
    );
    this.material.uniforms.uScrollY.value = this.scrollY.current;
    this.material.uniforms.uSpeedY.value *= 0.835;
    this.checkZWrapsAndAdvanceTracks();

    this.stepInteractionLerp();
    this.syncInteractionUniforms(this.material);
    this.syncInteractionUniforms(this.pickMaterial);

    this.pickMaterial.uniforms.uTime.value =
      this.material.uniforms.uTime.value;
    this.pickMaterial.uniforms.uScrollY.value =
      this.material.uniforms.uScrollY.value;
    this.pickMaterial.uniforms.uSpeedY.value =
      this.material.uniforms.uSpeedY.value;
    (this.pickMaterial.uniforms.uDrag.value as THREE.Vector2).copy(
      this.material.uniforms.uDrag.value as THREE.Vector2
    );
    if (this.material.uniforms.uAtlas.value) {
      this.pickMaterial.uniforms.uAtlas.value =
        this.material.uniforms.uAtlas.value;
    }
  }

  pick(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    pxX: number,
    pxY: number,
    bufferWidth: number,
    bufferHeight: number
  ): number | null {
    if (this.instanceToCoverIndex.length === 0) return null;
    if (!this.material.uniforms.uAtlas.value) return null;

    this.pickTarget.setSize(bufferWidth, bufferHeight);

    const prevRenderTarget = renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    const originalMaterial = this.mesh.material;
    this.mesh.material = this.pickMaterial;

    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(this.scene, camera);

    const clampedX = Math.max(0, Math.min(bufferWidth - 1, pxX));
    const clampedY = Math.max(0, Math.min(bufferHeight - 1, pxY));
    renderer.readRenderTargetPixels(
      this.pickTarget,
      clampedX,
      clampedY,
      1,
      1,
      this.pickPixel
    );

    this.mesh.material = originalMaterial;
    renderer.setRenderTarget(prevRenderTarget);
    renderer.setClearColor(prevClearColor, prevClearAlpha);

    if (this.pickPixel[3] === 0) return null;

    const id =
      this.pickPixel[0] |
      (this.pickPixel[1] << 8) |
      (this.pickPixel[2] << 16);
    return id;
  }

  dispose() {
    if (this.dragElement && this.pointerDown) {
      this.dragElement.removeEventListener("pointerdown", this.pointerDown);
    }
    if (this.pointerMove) window.removeEventListener("pointermove", this.pointerMove);
    if (this.pointerUp) window.removeEventListener("pointerup", this.pointerUp);
    window.removeEventListener("wheel", this.onWheelBound);

    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
    this.pickMaterial.dispose();
    this.pickTarget.dispose();
    this.atlasTexture?.dispose();
    this.blurryAtlasTexture?.dispose();
  }
}

function interpolate(current: number, target: number, ease: number) {
  return current + (target - current) * ease;
}
