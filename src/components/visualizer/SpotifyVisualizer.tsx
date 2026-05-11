"use client";

/**
 * React port of J0SUKE/spotify-visualiser `src/canvas.ts` + `src/main.ts`.
 * Clicks are GPU-picked; texture slots map through `coverIndexMap` to the
 * correct playlist track (tracks without covers are not in the atlas).
 * World XY: infinite canvas drag via `uDrag` in Planes (see original repo
 * [spotify-visualiser](https://github.com/J0SUKE/spotify-visualiser)).
 */

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import Planes, { type Size, type TrackCardInput } from "./Planes";
import type { NormalizedTrack } from "@/lib/types";

interface SpotifyVisualizerProps {
  tracks: NormalizedTrack[];
  onTrackSelect?: (track: NormalizedTrack) => void;
  className?: string;
  dim?: boolean;
}

const CLICK_MOVE_THRESHOLD_PX = 8;
const CLICK_TIME_THRESHOLD_MS = 350;

/**
 * One atlas row = one card. `Planes` uses MAX_ATLAS_HEIGHT 15000px; beyond
 * ~50 rows the atlas scales down so everything still fits. 100 rows trades a
 * bit of sharpness for less visible repetition when depth-scrolling.
 * Sample evenly when there are more cover rows; `coverIndexMap` + pick use it.
 */
const MAX_ATLAS_TEXTURE_ROWS = 100;

export default function SpotifyVisualizer({
  tracks,
  onTrackSelect,
  className,
  dim = false,
}: SpotifyVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const planesRef = useRef<Planes | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

  const onSelectRef = useRef(onTrackSelect);
  const dimRef = useRef(dim);
  const tracksRef = useRef<NormalizedTrack[]>(tracks);
  const coverIndexMapRef = useRef<number[]>([]);

  useEffect(() => {
    onSelectRef.current = onTrackSelect;
  }, [onTrackSelect]);
  useEffect(() => {
    dimRef.current = dim;
  }, [dim]);
  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  const { atlasItems, coverIndexMap } = useMemo(() => {
    const atlas: TrackCardInput[] = [];
    const map: number[] = [];
    tracks.forEach((track, i) => {
      if (track.albumCover.length > 0) {
        atlas.push({
          url: track.albumCover,
          title: track.title,
          artist: track.artist,
        });
        map.push(i);
      }
    });
    if (atlas.length <= MAX_ATLAS_TEXTURE_ROWS) {
      return { atlasItems: atlas, coverIndexMap: map };
    }
    // Even, gap-free striding so each atlas row is a different source track
    // before any repeat (Math.round can duplicate rows when the list is small).
    const outAtlas: TrackCardInput[] = [];
    const outMap: number[] = [];
    const last = atlas.length - 1;
    const want = Math.min(MAX_ATLAS_TEXTURE_ROWS, atlas.length);
    for (let r = 0; r < want; r++) {
      const src =
        want === 1
          ? 0
          : Math.min(last, Math.floor((r * last) / (want - 1)));
      outAtlas.push(atlas[src]!);
      outMap.push(map[src]!);
    }
    return { atlasItems: outAtlas, coverIndexMap: outMap };
  }, [tracks]);

  useEffect(() => {
    coverIndexMapRef.current = coverIndexMap;
  }, [coverIndexMap]);

  useEffect(() => {
    if (dim && planesRef.current) {
      planesRef.current.setPointerNdc(0, 2, false);
    }
  }, [dim]);

  useEffect(() => {
    planesRef.current?.setDragEnabled(!dim);
  }, [dim]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      100
    );
    scene.add(camera);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    const pixelRatio = Math.min(2, window.devicePixelRatio);
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    rendererRef.current = renderer;

    const computeSizes = (): Size => {
      const fov = camera.fov * (Math.PI / 180);
      const height = camera.position.z * Math.tan(fov / 2) * 2;
      const width = height * camera.aspect;
      return { width, height };
    };

    const planes = new Planes({
      scene,
      sizes: computeSizes(),
      meshCount: 550,
    });
    planes.setDragEnabled(!dimRef.current);
    planes.bindDrag(canvas);
    planesRef.current = planes;

    let downX = 0;
    let downY = 0;
    let downT = 0;
    /** Set on pointer down when not dim; used to ignore accidental pick after dim-only. */
    let strokeEligibleForClick = false;

    const updateProximity = (e: PointerEvent) => {
      const p = planesRef.current;
      if (!p) return;
      if (dimRef.current) {
        p.setPointerNdc(0, 2, false);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const ny = 1 - ((e.clientY - rect.top) / rect.height) * 2;
      p.setPointerNdc(nx, ny, true);
    };

    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downT = performance.now();
      if (dimRef.current) {
        strokeEligibleForClick = false;
        return;
      }
      strokeEligibleForClick = true;
      canvas.style.cursor = "grabbing";
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dimRef.current) {
        canvas.style.cursor = "grab";
      }
      if (dimRef.current) {
        strokeEligibleForClick = false;
        return;
      }
      const eligible = strokeEligibleForClick;
      strokeEligibleForClick = false;
      if (!eligible) return;

      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      const distance = Math.hypot(dx, dy);
      const duration = performance.now() - downT;
      if (distance > CLICK_MOVE_THRESHOLD_PX) return;
      if (duration > CLICK_TIME_THRESHOLD_MS) return;

      const map = coverIndexMapRef.current;
      if (map.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const drawBufferWidth = renderer.domElement.width;
      const drawBufferHeight = renderer.domElement.height;
      const pxX = Math.round(((e.clientX - rect.left) / rect.width) * drawBufferWidth);
      const pxY = Math.round(
        ((rect.bottom - e.clientY) / rect.height) * drawBufferHeight
      );

      const instanceId = planes.pick(
        renderer,
        camera,
        pxX,
        pxY,
        drawBufferWidth,
        drawBufferHeight
      );
      if (instanceId === null) return;

      const coverIndex = planes.coverIndexFor(instanceId);
      if (coverIndex === null) return;
      const trackListIndex = map[coverIndex];
      if (trackListIndex === undefined) {
        console.warn("[visualizer] cover-track mismatch", { coverIndex });
        return;
      }
      const track = tracksRef.current[trackListIndex];
      if (!track) {
        console.warn("[visualizer] cover-track mismatch", {
          coverIndex,
          trackListIndex,
        });
        return;
      }

      onSelectRef.current?.(track);
      planes.setSelectedInstance(instanceId);
    };

    const onPointerMove = (e: PointerEvent) => {
      updateProximity(e);
    };

    const onPointerLeaveCanvas = () => {
      planesRef.current?.setPointerNdc(0, 2, false);
    };

    const onPointerCancel = () => {
      if (!dimRef.current) {
        canvas.style.cursor = "grab";
      }
      strokeEligibleForClick = false;
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerleave", onPointerLeaveCanvas);
    canvas.addEventListener("pointercancel", onPointerCancel);

    const clock = new THREE.Clock();
    let lastTime = 0;
    let rafId = 0;
    const tick = () => {
      const now = clock.getElapsedTime();
      const delta = now - lastTime;
      lastTime = now;
      const normalizedDelta = delta / (1 / 60);
      planes.render(normalizedDelta);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight);
      planes.updateSizes(computeSizes());
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeaveCanvas);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      planes.dispose();
      renderer.dispose();
      planesRef.current = null;
      rendererRef.current = null;
      cameraRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const planes = planesRef.current;
    if (!planes) return;
    if (atlasItems.length === 0) return;
    let cancelled = false;
    (async () => {
      await planes.loadTrackCardAtlas(atlasItems);
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [atlasItems]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: 1,
        zIndex: 0,
        touchAction: "none",
        cursor: dim ? "default" : "grab",
      }}
    />
  );
}
