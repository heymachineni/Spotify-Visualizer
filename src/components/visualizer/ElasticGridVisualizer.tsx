"use client";

/**
 * Codrops-inspired elastic grid (ScrollSmoother + center-column lag +
 * velocity squash on tiles). Single visual preset aligned with Codrops Elastic IV + II motion.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { NormalizedTrack } from "@/lib/types";
import {
  attachElasticGallery,
  preloadElasticGridImages,
} from "@/lib/elasticGrid/attachElasticGallery";
import { useCodropsElasticScripts } from "@/hooks/useCodropsElasticScripts";

const MISSING_COVER =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect fill="#141418" width="256" height="256"/><text x="128" y="148" text-anchor="middle" fill="#5c5c66" font-size="72" font-family="system-ui,sans-serif">♪</text></svg>`
  );

export type ElasticGridVisualizerProps = {
  tracks: NormalizedTrack[];
  onTrackSelect?: (track: NormalizedTrack) => void;
};

/** One tile per track — no artificial repetition (that burned extra paint + confused picks). */
function cellsForTracks(
  tracks: NormalizedTrack[]
): Array<{ track: NormalizedTrack; key: string }> {
  return tracks.map((t, i) => ({
    track: t,
    key: `${t.id}__${i}`,
  }));
}

/**
 * Columns by viewport width:
 * – ≥1040px: dense 9-column reference layout
 * – 640–1039px: midsize band (readable tiles)
 * – &lt;640px: 2 or 3 columns from usable width — never pack more than fits
 */
function columnCountForLag(w: number): number {
  if (w >= 1040) return 9;
  if (w >= 640) return 5;
  /** ~minimum column ~108px incl. gutters → 3 cols need ~340px-ish */
  const minWForThreeCols = 400;
  return w >= minWForThreeCols ? 3 : 2;
}

function distributeCells(
  cells: Array<{ track: NormalizedTrack; key: string }>,
  numCols: number
): Array<Array<{ track: NormalizedTrack; key: string }>> {
  const cols: Array<Array<{ track: NormalizedTrack; key: string }>> =
    Array.from({ length: numCols }, () => []);
  cells.forEach((cell, idx) => {
    cols[idx % numCols]!.push(cell);
  });
  return cols;
}

export default function ElasticGridVisualizer({
  tracks,
  onTrackSelect,
}: ElasticGridVisualizerProps) {
  const {
    loaded: scriptsLoaded,
    error: scriptsError,
  } = useCodropsElasticScripts();
  const [colCount, setColCount] = useState(7);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const idToTrackRef = useRef<Map<string, NormalizedTrack>>(new Map());

  const cells = useMemo(() => cellsForTracks(tracks), [tracks]);

  useEffect(() => {
    const m = new Map<string, NormalizedTrack>();
    for (const t of tracks) m.set(t.id, t);
    idToTrackRef.current = m;
  }, [tracks]);

  useEffect(() => {
    const bump = () =>
      setColCount(columnCountForLag(window.innerWidth));
    bump();
    window.addEventListener("resize", bump);
    return () => window.removeEventListener("resize", bump);
  }, []);

  const columns = useMemo(
    () => distributeCells(cells, colCount),
    [cells, colCount]
  );

  const onGridClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest(
        "[data-track-id]"
      ) as HTMLElement | null;
      if (!el) return;
      const id = el.getAttribute("data-track-id");
      if (!id) return;
      const t = idToTrackRef.current.get(id);
      if (t) onTrackSelect?.(t);
    },
    [onTrackSelect]
  );

  useLayoutEffect(() => {
    if (!scriptsLoaded || !gridRef.current || cells.length === 0) {
      return;
    }
    const grid = gridRef.current;
    let cancelled = false;
    let detach = () => {};

    void preloadElasticGridImages(grid).then(() => {
      if (cancelled || !grid.isConnected) return;
      detach = attachElasticGallery(grid);
    });

    return () => {
      cancelled = true;
      detach();
    };
  }, [scriptsLoaded, colCount, cells]);

  if (tracks.length === 0) {
    return (
      <div className="elastic-grid-scroll-root elastic-grid-scroll-root--empty">
        <p className="elastic-grid-scroll__empty">Load a playlist to browse.</p>
      </div>
    );
  }

  return (
    <div className="elastic-grid-scroll-root elastic-grid-scroll-root--lag">
      {scriptsError ? (
        <p className="elastic-grid-scroll__error" role="alert">
          {scriptsError}
        </p>
      ) : null}
      <div id="smooth-wrapper" className="elastic-grid-scroll__smooth-wrapper">
        <main id="smooth-content" className="elastic-grid-scroll__smooth-content">
          <div
            ref={gridRef}
            className="elastic-grid-scroll__grid elastic-grid-scroll__grid--lag"
            style={
              {
                "--elastic-cols": colCount,
              } as React.CSSProperties
            }
            onClick={onGridClick}
            role="list"
          >
            {columns.map((col, ci) => (
              <div key={ci} className="grid__column" role="presentation">
                {col.map((cell) => {
                  const cover =
                    cell.track.albumCover.length > 0
                      ? cell.track.albumCover
                      : MISSING_COVER;
                  return (
                    <figure
                      key={cell.key}
                      className="grid__item"
                      data-track-id={cell.track.id}
                      role="listitem"
                    >
                      <div
                        className="grid__item-img"
                        style={{ backgroundImage: `url(${cover})` }}
                      />
                      <figcaption className="grid__item-caption">
                        {cell.track.title}
                        {cell.track.artist ? ` — ${cell.track.artist}` : ""}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
