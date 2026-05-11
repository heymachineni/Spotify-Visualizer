/**
 * Codrops Elastic Grid Scroll (Elastic IV): GSAP ScrollSmoother center-column lag
 * plus demo-2 scroll-velocity squash on tiles. Single preset only.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

function globals() {
  return {
    gsap: (typeof window !== "undefined" && (window as any).gsap) || null,
    ScrollTrigger:
      (typeof window !== "undefined" && (window as any).ScrollTrigger) || null,
    ScrollSmoother:
      (typeof window !== "undefined" && (window as any).ScrollSmoother) || null,
  };
}

export function preloadElasticGridImages(grid: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const imagesLoadedFn = (window as any).imagesLoaded;
    if (!imagesLoadedFn) {
      resolve();
      return;
    }
    const nodes = grid.querySelectorAll(".grid__item-img");
    if (nodes.length === 0) {
      resolve();
      return;
    }
    imagesLoadedFn(nodes as NodeListOf<Element>, { background: true }, () =>
      resolve()
    );
  });
}

export function attachElasticGallery(grid: HTMLElement): () => void {
  const { gsap, ScrollTrigger, ScrollSmoother } = globals();

  const noop = () => {};
  if (!gsap || !ScrollTrigger || !ScrollSmoother) return noop;

  gsap.registerPlugin(ScrollTrigger, ScrollSmoother);

  let smootherInstance: any;
  try {
    smootherInstance = ScrollSmoother.create({
      smooth: 1,
      effects: true,
      normalizeScroll: true,
    });
  } catch {
    return noop;
  }

  const smoother = smootherInstance;

  let tickerFn: (() => void) | null = null;
  const minScaleX = 0.7;
  const maxScaleY = 1.7;
  const scrollSensitivity = 4000;
  const thresholdVel = 700;

  tickerFn = () => {
    const rawVel = smoother.getVelocity();
    const absVel = Math.abs(rawVel);
    const vRaw = Math.max(0, absVel - thresholdVel);
    const v = Math.min(vRaw / scrollSensitivity, 1);
    const si = 1 + (minScaleX - 1) * v;
    const sy = 1 + (maxScaleY - 1) * v;
    const origin = rawVel < 0 ? "50% 0%" : "50% 100%";
    grid.style.setProperty("--eg-si", String(si));
    grid.style.setProperty("--eg-sy", String(sy));
    grid.style.setProperty("--eg-to", origin);
  };
  gsap.ticker.add(tickerFn);

  const columnEls = Array.from(
    grid.querySelectorAll(".grid__column")
  ) as HTMLElement[];

  const mid = (columnEls.length - 1) / 2;
  const n = columnEls.length;
  const baseLag = 0.3;
  const lagFactor = 0.15;
  const maxDistance = n % 2 === 1 ? Math.floor(n / 2) : n / 2;

  columnEls.forEach((el, i) => {
    const distance = Math.abs(i - mid);
    const lag = baseLag + (maxDistance - distance + 1) * lagFactor;
    smoother.effects(el, { speed: 1, lag });
  });

  ScrollTrigger.refresh();

  return () => {
    if (tickerFn) gsap.ticker.remove(tickerFn);
    tickerFn = null;
    smoother.kill?.();
    grid.style.removeProperty("--eg-si");
    grid.style.removeProperty("--eg-sy");
    grid.style.removeProperty("--eg-to");
  };
}
