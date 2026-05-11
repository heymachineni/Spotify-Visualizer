"use client";

/**
 * Album-column variant of `DistortionColumn`.
 *
 * IMPORTANT: the scroll math, easing, wrap-around logic and `curve()` formula
 * are copied 1:1 from `DistortionColumn.tsx`, which itself is a faithful port
 * of JorgeCapillo/infinite-scrolling-text-distortion's `column.js`. The only
 * differences are:
 *   - the rendered item is a small album-card instead of a line of text
 *   - a delegated click handler routes taps on a card back to `onTrackClick`
 *
 * The `.line` wrapper that receives the `translateX(curve(...))` distortion
 * transform stays in place — each album card wobbles with the same sin/cos
 * amplitude used by the text columns.
 */

import { useEffect, useRef } from "react";
import type { NormalizedTrack } from "@/lib/types";

interface DistortionAlbumColumnProps {
  tracks: NormalizedTrack[];
  reverse?: boolean;
  defaultSpeed?: number;
  onTrackClick?: (track: NormalizedTrack) => void;
  className?: string;
  style?: React.CSSProperties;
}

export default function DistortionAlbumColumn({
  tracks,
  reverse = false,
  defaultSpeed = 0.45,
  onTrackClick,
  className,
  style,
}: DistortionAlbumColumnProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onClickRef = useRef(onTrackClick);
  useEffect(() => {
    onClickRef.current = onTrackClick;
  }, [onTrackClick]);

  // Keep a stable lookup (id → track) around so the delegated click handler
  // can map a data-track-id back to the track object even after re-renders.
  const trackMapRef = useRef<Map<string, NormalizedTrack>>(new Map());
  useEffect(() => {
    const m = new Map<string, NormalizedTrack>();
    for (const t of tracks) m.set(t.id, t);
    trackMapRef.current = m;
  }, [tracks]);

  useEffect(() => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    if (tracks.length === 0) {
      content.innerHTML = "";
      return;
    }

    // --- Animation state (mirrors DistortionColumn exactly) ----------------
    const scroll = { ease: 0.05, current: 0, target: 0, last: 0 };
    const speed = { t: defaultSpeed, c: defaultSpeed };
    const touch = { prev: 0, start: 0 };
    let direction: "up" | "down" | "" = "";
    let winH = window.innerHeight;
    let height = 0;
    let delta = 0;
    let rafId = 0;
    let destroyed = false;
    let startTs: number | undefined;

    type Item = {
      el: HTMLElement;
      bounds: DOMRect;
      y: number;
      extra: number;
      lines: { el: HTMLElement; top: number; height: number }[];
      isBefore?: boolean;
      isAfter?: boolean;
    };

    let items: Item[] = [];

    const ensureFilled = () => {
      const h = content.scrollHeight;
      const ratio = h / winH || 1;
      if (ratio < 2) {
        const copies = Math.min(Math.ceil(winH / Math.max(h, 1)), 100);
        const originals = Array.from(content.children);
        for (let i = 0; i < copies; i++) {
          originals.forEach((el) => {
            content.appendChild(el.cloneNode(true));
          });
        }
      }
    };

    const curve = (y: number, t = 0) => {
      const tt = t * 0.0007;
      const amp = 15 + (5 * delta) / 100;
      return reverse
        ? Math.cos(y * Math.PI + tt) * amp
        : Math.sin(y * Math.PI + tt) * amp;
    };

    const renderMarkup = () =>
      tracks
        .map(
          (t) => `
          <div class="album-col-item" data-track-id="${escapeHtml(t.id)}">
            <div class="line">
              <div class="album-col-card">
                <div class="album-col-card__cover">
                  ${
                    t.albumCover
                      ? `<img src="${escapeHtml(
                          t.albumCover
                        )}" alt="${escapeHtml(
                          t.title
                        )}" loading="lazy" draggable="false" />`
                      : ""
                  }
                </div>
                <div class="album-col-card__text">
                  <div class="album-col-card__title">${escapeHtml(t.title)}</div>
                  <div class="album-col-card__artist">${escapeHtml(t.artist)}</div>
                </div>
              </div>
            </div>
          </div>`
        )
        .join("");

    const measure = () => {
      winH = window.innerHeight;
      content.innerHTML = renderMarkup();

      ensureFilled();

      items = Array.from(content.children).map((el) => {
        const node = el as HTMLElement;
        const bounds = node.getBoundingClientRect();
        const lineEls = Array.from(node.querySelectorAll<HTMLElement>(".line"));
        return {
          el: node,
          bounds,
          y: 0,
          extra: 0,
          lines: lineEls.map((lineEl) => ({
            el: lineEl,
            top: lineEl.offsetTop,
            height: lineEl.clientHeight,
          })),
        };
      });

      height = content.scrollHeight;
      scroll.current = 0;
      scroll.target = 0;
      speed.c = defaultSpeed;
      speed.t = defaultSpeed;
    };

    const update = (current: number, t = 0) => {
      for (const item of items) {
        item.isBefore = item.y + item.bounds.top > winH;
        item.isAfter = item.y + item.bounds.top + item.bounds.height < 0;

        if (!reverse) {
          if (direction === "up" && item.isBefore) {
            item.extra -= height;
            item.isBefore = false;
            item.isAfter = false;
          }
          if (direction === "down" && item.isAfter) {
            item.extra += height;
            item.isBefore = false;
            item.isAfter = false;
          }
          item.y = -current + item.extra;
        } else {
          if (direction === "down" && item.isBefore) {
            item.extra -= height;
            item.isBefore = false;
            item.isAfter = false;
          }
          if (direction === "up" && item.isAfter) {
            item.extra += height;
            item.isBefore = false;
            item.isAfter = false;
          }
          item.y = current + item.extra;
        }

        for (const line of item.lines) {
          const posY = line.top + item.y;
          const progress = Math.min(Math.max(0, posY / winH), 1);
          const x = curve(progress, t);
          line.el.style.transform = `translateX(${x}px)`;
        }

        item.el.style.transform = `translateY(${item.y}px)`;
      }
    };

    const render = (t: number) => {
      if (destroyed) return;
      if (startTs === undefined) startTs = t;
      const elapsed = t - startTs;

      speed.c += (speed.t - speed.c) * 0.05;
      scroll.target += speed.c;
      scroll.current += (scroll.target - scroll.current) * scroll.ease;
      delta = scroll.target - scroll.current;

      if (scroll.current > scroll.last) {
        direction = "down";
        speed.t = defaultSpeed;
      } else if (scroll.current < scroll.last) {
        direction = "up";
        speed.t = -defaultSpeed;
      }

      update(scroll.current, elapsed);
      scroll.last = scroll.current;

      rafId = requestAnimationFrame(render);
    };

    const onWheel = (e: WheelEvent) => {
      const wheelDeltaY = (e as unknown as { wheelDeltaY?: number }).wheelDeltaY;
      let t = wheelDeltaY ?? -1 * e.deltaY;
      t *= 0.254;
      scroll.target += -t;
    };

    const onTouchStart = (e: TouchEvent) => {
      touch.prev = scroll.current;
      touch.start = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches?.[0]?.clientY ?? 0;
      const distance = (touch.start - y) * 2;
      scroll.target = touch.prev + distance;
    };

    const onResize = () => measure();

    // Click delegation — a tap on a cloned card finds its nearest
    // `[data-track-id]` ancestor and resolves it back to a track object.
    // Click-vs-drag is enforced with a small pointer-distance threshold so
    // dragging the column to browse doesn't accidentally trigger playback.
    let downX = 0;
    let downY = 0;
    let pressed = false;
    const onPointerDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      pressed = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pressed) return;
      pressed = false;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (Math.hypot(dx, dy) > 6) return;
      const target = e.target as HTMLElement | null;
      const card = target?.closest("[data-track-id]") as HTMLElement | null;
      if (!card) return;
      const id = card.getAttribute("data-track-id");
      if (!id) return;
      const track = trackMapRef.current.get(id);
      if (track) onClickRef.current?.(track);
    };

    measure();
    rafId = requestAnimationFrame(render);

    window.addEventListener("resize", onResize);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointerup", onPointerUp);

    return () => {
      destroyed = true;
      cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("pointerup", onPointerUp);
      content.innerHTML = "";
    };
  }, [tracks, reverse, defaultSpeed]);

  return (
    <div
      ref={rootRef}
      className={`distortion-column distortion-column--albums ${className ?? ""}`}
      style={style}
    >
      <div ref={contentRef} className="distortion-content" />
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
