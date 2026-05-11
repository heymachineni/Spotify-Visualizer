"use client";

/**
 * InstructionCard — a small top-right hint that tells first-time users
 * how to interact with the WebGL playground. It dismisses on three
 * triggers, whichever comes first:
 *
 *   1. the user clicks the × close button
 *   2. the user performs any scroll gesture (wheel or touchmove)
 *   3. the page is reloaded inside the same session and the dismiss flag
 *      is already set in sessionStorage
 *
 * Once dismissed it stays hidden until the browser session ends.
 */

import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

const STORAGE_KEY = "svp.instruction-dismissed";

export default function InstructionCard() {
  // Start hidden; flip visible on mount once we've confirmed the flag
  // isn't already set — prevents a flash of the card in returning
  // sessions.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let already = false;
    try {
      already = sessionStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      // sessionStorage is unavailable (e.g. privacy-locked) — show anyway.
    }
    if (!already) setDismissed(false);
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      sessionStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // non-fatal
    }
  }, []);

  // Auto-dismiss on the first scroll interaction.
  useEffect(() => {
    if (dismissed) return;
    const onScroll = () => dismiss();
    window.addEventListener("wheel", onScroll, { passive: true });
    window.addEventListener("touchmove", onScroll, { passive: true });
    return () => {
      window.removeEventListener("wheel", onScroll);
      window.removeEventListener("touchmove", onScroll);
    };
  }, [dismissed, dismiss]);

  return (
    <AnimatePresence>
      {!dismissed && (
        <motion.div
          className="instruction-card"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <button
            type="button"
            className="instruction-card__close"
            onClick={dismiss}
            aria-label="Dismiss instructions"
          >
            ×
          </button>
          <div className="instruction-card__eyebrow">How to play</div>
          <div className="instruction-card__body">
            <span className="kbd">drag sideways</span> to orbit the covers,&nbsp;
            <span className="kbd">scroll</span> (desktop) /
            <span className="kbd">swipe up&nbsp;&amp;&nbsp;down</span> (touch) for depth,&nbsp;
            <span className="kbd">tap</span> a cover to play it.
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
