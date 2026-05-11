"use client";

import { useEffect, useState } from "react";

/** Script load order — Codrops demo assumes globals on `window`. */
const VENDOR_FILES = [
  "gsap.min.js",
  "ScrollTrigger.min.js",
  "ScrollSmoother.min.js",
  "imagesloaded.pkgd.min.js",
] as const;

function hasElasticGlobals(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as {
    gsap?: unknown;
    ScrollTrigger?: unknown;
    ScrollSmoother?: unknown;
    imagesLoaded?: unknown;
  };
  return Boolean(
    w.gsap &&
      w.ScrollTrigger &&
      w.ScrollSmoother &&
      typeof w.imagesLoaded === "function"
  );
}

function vendorBase(): string {
  return `${window.location.origin}/vendor/codrops-elastic/`;
}

/** Remove half-failed script tags so a retry can re-fetch cleanly. */
function removeDuplicateVendorScripts() {
  const baseSlash = "/vendor/codrops-elastic/";
  for (const f of VENDOR_FILES) {
    const abs = `${window.location.origin}${baseSlash}${f}`;
    document
      .querySelectorAll(
        `script[src="${abs}"],script[src="${baseSlash}${f}"]`
      )
      .forEach((n) => n.remove());
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = () => resolve();
    s.onerror = () => {
      s.remove();
      reject(new Error(`Failed to load ${src}`));
    };
    document.head.appendChild(s);
  });
}

/**
 * Single shared load attempt. On failure we **null** this out so a later
 * elastic mode mount can retry (the old code kept a rejected `loadPromise`
 * forever, which permanently broke ScrollSmoother after one network hiccup).
 */
let elasticLoadInFlight: Promise<void> | null = null;

async function ensureElasticVendorLoaded(): Promise<void> {
  if (hasElasticGlobals()) return;

  removeDuplicateVendorScripts();
  const base = vendorBase();
  for (const file of VENDOR_FILES) {
    if (hasElasticGlobals()) return;
    await loadScript(base + file);
  }
  if (!hasElasticGlobals()) {
    throw new Error(
      "Elastic grid scripts ran but expected globals (gsap / ScrollTrigger / ScrollSmoother / imagesLoaded) are missing."
    );
  }
}

/**
 * Sequential load of Codrops Elastic Grid deps (globals: gsap, ScrollTrigger,
 * ScrollSmoother, imagesLoaded). Safe to call from multiple components.
 *
 * Uses absolute `window.location.origin` URLs so the path always matches how
 * the browser reached the app (avoids edge cases with `localhost` vs
 * `127.0.0.1` relative resolution).
 */
export function useCodropsElasticScripts(): {
  loaded: boolean;
  error: string | null;
} {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (hasElasticGlobals()) {
      setLoaded(true);
      setError(null);
      return;
    }

    elasticLoadInFlight ??= ensureElasticVendorLoaded().catch((err) => {
      elasticLoadInFlight = null;
      removeDuplicateVendorScripts();
      throw err;
    });

    elasticLoadInFlight
      .then(() => {
        setLoaded(true);
        setError(null);
      })
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Script load failed")
      );
  }, []);

  return { loaded, error };
}
