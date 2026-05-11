"use client";

import { useEffect, useState } from "react";

export interface UseAutoHideOnScrollOptions {
  /** When true, the overlay is never auto-hidden (e.g. docked in the bottom bar). */
  disabled?: boolean;
}

/**
 * Hides an overlay when the user starts scrolling (wheel / touchmove) and
 * shows it again on the first pointer interaction.
 */
export function useAutoHideOnScroll(
  opts?: UseAutoHideOnScrollOptions
): boolean {
  const disabled = opts?.disabled ?? false;
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (disabled) return;
    const hide = () => setHidden(true);
    const show = () => setHidden(false);

    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("touchmove", hide, { passive: true });
    window.addEventListener("pointermove", show, { passive: true });
    window.addEventListener("pointerdown", show, { passive: true });
    window.addEventListener("touchstart", show, { passive: true });
    window.addEventListener("click", show, { passive: true });

    return () => {
      window.removeEventListener("wheel", hide);
      window.removeEventListener("touchmove", hide);
      window.removeEventListener("pointermove", show);
      window.removeEventListener("pointerdown", show);
      window.removeEventListener("touchstart", show);
      window.removeEventListener("click", show);
    };
  }, [disabled]);

  return disabled ? false : hidden;
}
