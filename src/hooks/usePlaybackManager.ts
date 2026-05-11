"use client";

/**
 * Thin React adapter around `PlaybackManager`.
 *
 * Gives the page a stable manager instance for the life of the
 * component while keeping the product-type and embed-handle inputs
 * "live" — the manager reads them via the getters passed at
 * construction, so updates after mount are picked up without
 * recreating the instance (which would also tear down the SDK
 * connection on every product-type flip).
 */

import { useEffect, useRef } from "react";
import {
  PlaybackManager,
  type UserProductType,
} from "@/components/player/PlaybackManager";
import type { SpotifyEmbedPlayerHandle } from "@/components/player/SpotifyEmbedPlayer";

export interface UsePlaybackManagerArgs {
  embedRef: React.RefObject<SpotifyEmbedPlayerHandle | null>;
  productType: UserProductType;
}

export function usePlaybackManager({
  embedRef,
  productType,
}: UsePlaybackManagerArgs): PlaybackManager {
  // Track the latest product type in a ref so the manager can read
  // it during an in-flight `play()` without re-creating the instance.
  const productTypeRef = useRef<UserProductType>(productType);
  useEffect(() => {
    productTypeRef.current = productType;
  }, [productType]);

  const managerRef = useRef<PlaybackManager | null>(null);
  if (managerRef.current === null) {
    managerRef.current = new PlaybackManager({
      getEmbedHandle: () => embedRef.current,
      getProductType: () => productTypeRef.current,
    });
  }

  useEffect(() => {
    const m = managerRef.current;
    return () => {
      m?.dispose();
    };
  }, []);

  return managerRef.current;
}
