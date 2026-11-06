// Vertical crop around the runner. Computed once for the whole clip (not per
// frame) so the framing stays steady in the viewer and the export.

import type { FrameMetrics, PoseFrame } from "./types";

export interface Crop {
  y: number;
  h: number;
}

const MIN_VIS = 0.3;

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}

/**
 * Crop to the vertical extent of the poses across the clip, with headroom for
 * the top of the head (landmarks stop at the eyes) and the strike banner, and
 * room below the ground line for the reach label. Uses percentiles so a single
 * bad detection doesn't blow the crop open. Returns undefined when cropping
 * would save less than ~8% of the frame.
 */
export function computeCrop(frames: PoseFrame[], metrics: FrameMetrics[], width: number, height: number): Crop | undefined {
  const tops: number[] = [];
  const bottoms: number[] = [];
  frames.forEach((f, i) => {
    let top = Infinity;
    let bottom = metrics[i]?.groundY ?? -Infinity;
    for (const p of f.pts) {
      if (p.v < MIN_VIS) continue;
      top = Math.min(top, p.y);
      bottom = Math.max(bottom, p.y);
    }
    if (Number.isFinite(top)) tops.push(top);
    if (Number.isFinite(bottom)) bottoms.push(bottom);
  });
  if (!tops.length || !bottoms.length) return undefined;

  const top = percentile(tops, 0.02);
  const bottom = percentile(bottoms, 0.98);
  const body = Math.max(1, bottom - top);
  const s = Math.max(1, width / 540); // matches the overlay's text scale

  const y0 = Math.max(0, top - body * 0.15 - 36 * s);
  const y1 = Math.min(height, bottom + body * 0.06 + 56 * s);
  const y = Math.floor(y0 / 2) * 2;
  const h = Math.min(height - y, Math.ceil((y1 - y) / 2) * 2);
  if (h > height * 0.92) return undefined;
  return { y, h };
}
