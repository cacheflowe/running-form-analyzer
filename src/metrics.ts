// Running-form measurements from 2D pose landmarks.
//
// Everything here assumes a roughly side-on, level, stationary camera. Angles
// are measured in the image plane, so they're a guide rather than a lab-grade
// measurement — a camera that's off-axis will distort them.
//
// Pipeline:
//   1. Fix frames where the model swapped the left/right legs (common in side
//      view when the legs cross) by checking continuity with the previous frame.
//   2. Work out the direction of travel per segment.
//   3. Estimate the ground line and flag which foot is in contact on each frame.
//   4. At each initial contact, measure shin angle, foot angle, reach and knee
//      flexion to classify the strike and flag overstriding.

import { ARM_PAIRS, L, LEG_PAIRS, SIDE } from "./landmarks";
import type { FrameMetrics, PoseFrame, Pt, Rating, Side, Strike } from "./types";

const SIDES: Side[] = ["left", "right"];
const MIN_VIS = 0.3;
const DEG = 180 / Math.PI;

// ---------------------------------------------------------------- geometry

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, v: Math.min(a.v, b.v) });

/** Interior angle at b (degrees, 0–180). */
export function jointAngle(a: Pt, b: Pt, c: Pt): number {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}

const visible = (...pts: Pt[]) => pts.every((p) => p && p.v >= MIN_VIS);

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ---------------------------------------------------------------- ratings

/** Rough coaching thresholds. Tweak to taste. */
export const rate = {
  shin: (deg: number): Rating => (deg <= 6 ? "good" : deg <= 12 ? "warn" : "bad"),
  reach: (legs: number): Rating => (legs <= 0.15 ? "good" : legs <= 0.3 ? "warn" : "bad"),
  kneeFlexAtContact: (deg: number): Rating => (deg >= 15 ? "good" : deg >= 8 ? "warn" : "bad"),
  elbow: (deg: number): Rating => (deg >= 60 && deg <= 110 ? "good" : deg >= 45 && deg <= 130 ? "warn" : "bad"),
  trunk: (deg: number): Rating => (deg >= 2 && deg <= 15 ? "good" : deg >= -2 && deg <= 20 ? "warn" : "bad"),
  foot: (t: Strike["footType"]): Rating => (t === "heel" ? "warn" : "good"),
  /** Vertical oscillation in leg lengths (~0.09 ≈ 8 cm for a 90 cm leg). */
  bounce: (legs: number): Rating => (legs <= 0.09 ? "good" : legs <= 0.12 ? "warn" : "bad"),
  /** Thigh angle behind vertical at toe-off. */
  hipExtension: (deg: number): Rating => (deg >= 10 ? "good" : deg >= 5 ? "warn" : "bad"),
};

/** Hip-to-ankle length as a fraction of standing height (thigh 0.245 + shank 0.246, Winter). */
export const LEG_FRACTION_OF_HEIGHT = 0.491;

// ---------------------------------------------------------------- analysis

export interface FormAnalysis {
  metrics: FrameMetrics[];
  strikes: Strike[];
  legLength: number;
}

export function analyzeForm(frames: PoseFrame[], fps: number): FormAnalysis {
  const legLength = estimateLegLength(frames);
  fixSwaps(frames, legLength);

  const segments = groupSegments(frames);
  const metrics: FrameMetrics[] = new Array(frames.length);
  const strikes: Strike[] = [];
  const globalDir = facingVote(frames, frames.map((_, i) => i)) >= 0 ? 1 : -1;

  for (const idx of segments) {
    const dir = segmentDirection(frames, idx, legLength) ?? globalDir;
    const ground = groundLine(frames, idx, fps);
    const tol = 0.06 * legLength;

    idx.forEach((fi, k) => {
      const pts = frames[fi].pts;
      metrics[fi] = {
        dir,
        elbow: sideRecord((s) => angleAt(pts, SIDE[s].shoulder, SIDE[s].elbow, SIDE[s].wrist)),
        knee: sideRecord((s) => angleAt(pts, SIDE[s].hip, SIDE[s].knee, SIDE[s].ankle)),
        trunkLean: trunkLean(pts, dir),
        contact: sideRecord((s) => ground[k] - footLow(pts, s) < tol),
        groundY: ground[k],
      };
    });

    // Initial contact = first contact frame after a swing phase
    const minGap = Math.max(2, Math.round(fps * 0.06)); // frames of swing required before a new strike
    for (const side of SIDES) {
      let swingRun = 0;
      let lastStrikeTime = -Infinity;
      idx.forEach((fi, k) => {
        const inContact = metrics[fi].contact[side];
        if (!inContact) {
          swingRun++;
          return;
        }
        if (k > 0 && swingRun >= minGap && frames[fi].time - lastStrikeTime > 0.4) {
          const settled = settleFrame(frames, idx, k, side, fps, legLength);
          // Frames the strike moved past were still in the air
          for (let j = k; j < settled; j++) metrics[idx[j]].contact[side] = false;
          const landed = idx[settled];
          const t = frames[landed].time;
          const strike = measureStrike(frames[landed].pts, side, dir, legLength, landed, t);
          // A real touchdown happens near or ahead of the hip; a foot well
          // behind the hip is the trailing foot flickering at toe-off.
          // Only count it with shoulders-to-toes in frame: partial poses at the
          // frame edges give unreliable hip/direction/angle measurements.
          if (strike && strike.reach > -0.15 && frames[landed].fullBody) {
            strikes.push(strike);
            lastStrikeTime = t;
          }
        }
        swingRun = 0;
      });
    }
  }

  strikes.sort((a, b) => a.time - b.time);
  measurePhases(frames, metrics, strikes, legLength);
  return { metrics, strikes, legLength };
}

/**
 * Per-strike measurements that need the frames after touchdown:
 *  - toe-off (last frame on the ground) → contact time and hip extension
 *  - peak knee bend during the following swing (heel recovery)
 *  - vertical oscillation of the hips over the step to the next strike
 */
function measurePhases(frames: PoseFrame[], metrics: FrameMetrics[], strikes: Strike[], legLength: number) {
  strikes.forEach((s, n) => {
    const seg = frames[s.frame].segment;
    const f = SIDE[s.side];
    const inSeg = (i: number) => i < frames.length && frames[i].segment === seg;

    // Toe-off: last contact frame, only if the foot leaves the ground in view
    let i = s.frame;
    while (inSeg(i + 1) && metrics[i + 1].contact[s.side]) i++;
    measureLoad(frames, metrics, s, i, legLength);
    if (inSeg(i + 1)) {
      s.toeOffFrame = i;
      s.contactTime = frames[i + 1].time - s.time;
      const p = frames[i].pts;
      if (visible(p[f.hip], p[f.knee])) {
        // Thigh angle behind vertical (positive = knee behind hip)
        s.hipExtension = Math.atan2(-metrics[i].dir * (p[f.knee].x - p[f.hip].x), p[f.knee].y - p[f.hip].y) * DEG;
      }

      // Swing: from toe-off to this foot's next strike (or end of segment)
      const next = strikes.find((o, m) => m > n && o.side === s.side);
      const end = next && frames[next.frame].segment === seg ? next.frame : Infinity;
      let peak = -Infinity;
      for (let j = i + 1; inSeg(j) && j < end; j++) {
        const k = metrics[j].knee[s.side];
        if (k !== undefined) peak = Math.max(peak, 180 - k);
      }
      // Only report when the whole swing is in view
      if (Number.isFinite(peak) && end !== Infinity) s.swingKneeFlex = peak;
    }

    // Bounce: hip center range over the step to the next strike (either foot)
    const next = strikes[n + 1];
    if (next && frames[next.frame].segment === seg && next.time - s.time < 0.6) {
      let lo = Infinity, hi = -Infinity;
      for (let j = s.frame; j <= next.frame; j++) {
        const p = frames[j].pts;
        const y = (p[L.leftHip].y + p[L.rightHip].y) / 2;
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      s.bounce = (hi - lo) / legLength;
    }
  });
}

/**
 * Loaded frame: after touchdown, body weight comes onto the foot. The foot
 * rolls flat (a heel striker's forefoot slaps down, a forefoot striker's heel
 * drops), the shoe compresses and the knee keeps bending, so the whole foot
 * (heel, toe and ankle together) is pressed lowest a frame or a few
 * milliseconds after first touch. Takes the frame where their mean height is
 * lowest within the first 0.12 s of stance (before the heel starts lifting),
 * keeping the earliest frame within 0.5% of a leg length so landmark jitter
 * doesn't push it late.
 */
function measureLoad(frames: PoseFrame[], metrics: FrameMetrics[], s: Strike, lastContact: number, legLength: number) {
  const f = SIDE[s.side];
  const end = Math.min(lastContact, frames.length - 1);
  const depth: number[] = [];
  for (let j = s.frame; j <= end && frames[j].time - s.time <= 0.12; j++) {
    const p = frames[j].pts;
    depth.push((p[f.heel].y + p[f.toe].y + p[f.ankle].y) / 3);
  }
  if (!depth.length) return;
  const lowest = Math.max(...depth);
  const k = depth.findIndex((y) => y >= lowest - 0.005 * legLength);
  const load = s.frame + k;
  s.loadFrame = load;
  s.timeToLoad = frames[load].time - s.time;
  const p = frames[load].pts;
  if (visible(p[f.knee], p[f.ankle])) {
    s.shinAtLoad = Math.atan2(metrics[load].dir * (p[f.ankle].x - p[f.knee].x), p[f.ankle].y - p[f.knee].y) * DEG;
  }
}

/**
 * The contact threshold fires as soon as the foot is *near* the ground, which
 * can be a frame or two before it actually lands. Refine it by finding the
 * level this foot rests at during the stance, then take the first frame where
 * the foot is within ~1.5% of a leg length of that level.
 *
 * The resting level is the 75th percentile of the foot's lowest point over the
 * next ~150 ms. A percentile rather than the max ignores landmark jitter; one
 * biased toward the ground (rather than the median) stays correct at high
 * frame rates, where many frames at the start of the window are still the
 * final ~5 cm of descent. The window is in real time, so it covers the same
 * part of the stance at 30 or 240 fps.
 *
 * "Keep advancing while the foot is still dropping" overshoots: the shoe keeps
 * sinking a little as it flattens and compresses after first touch.
 * Returns the refined position in idx.
 */
function settleFrame(frames: PoseFrame[], idx: number[], k: number, side: Side, fps: number, legLength: number): number {
  const window = Math.max(4, Math.round(fps * 0.15));
  const lows: number[] = [];
  for (let j = k; j < Math.min(idx.length, k + window); j++) lows.push(footLow(frames[idx[j]].pts, side));
  const sorted = [...lows].sort((a, b) => a - b);
  const rest = sorted[Math.round(0.75 * (sorted.length - 1))];
  const tol = 0.015 * legLength;
  const j = lows.findIndex((y) => y >= rest - tol);
  return k + Math.max(0, j);
}

function sideRecord<T>(fn: (s: Side) => T): Record<Side, T> {
  return { left: fn("left"), right: fn("right") };
}

function angleAt(pts: Pt[], a: number, b: number, c: number): number | undefined {
  return visible(pts[a], pts[b], pts[c]) ? jointAngle(pts[a], pts[b], pts[c]) : undefined;
}

function trunkLean(pts: Pt[], dir: 1 | -1): number | undefined {
  const sh = mid(pts[L.leftShoulder], pts[L.rightShoulder]);
  const hip = mid(pts[L.leftHip], pts[L.rightHip]);
  if (!visible(sh, hip)) return undefined;
  // Angle of hip→shoulder from straight up, positive when shoulders are ahead
  return Math.atan2(dir * (sh.x - hip.x), hip.y - sh.y) * DEG;
}

/** Lowest point of the foot (largest y). */
function footLow(pts: Pt[], s: Side): number {
  const f = SIDE[s];
  return Math.max(pts[f.ankle].y, pts[f.heel].y, pts[f.toe].y);
}

function measureStrike(pts: Pt[], side: Side, dir: 1 | -1, legLength: number, frame: number, time: number): Strike | null {
  const f = SIDE[side];
  const hip = pts[f.hip], knee = pts[f.knee], ankle = pts[f.ankle], heel = pts[f.heel], toe = pts[f.toe];
  if (!visible(hip, knee, ankle)) return null;
  const hipC = mid(pts[L.leftHip], pts[L.rightHip]);

  const shinAngle = Math.atan2(dir * (ankle.x - knee.x), ankle.y - knee.y) * DEG;
  const footAngle = Math.atan2(heel.y - toe.y, dir * (toe.x - heel.x)) * DEG;
  const footType: Strike["footType"] = footAngle > 8 ? "heel" : footAngle < -4 ? "forefoot" : "midfoot";
  const reach = (dir * (ankle.x - hipC.x)) / legLength;
  const kneeFlexion = 180 - jointAngle(hip, knee, ankle);

  return {
    frame,
    side,
    time,
    shinAngle,
    footAngle,
    footType,
    reach,
    kneeFlexion,
    overstride: shinAngle > 10 || reach > 0.3,
  };
}

/** Median hip→knee→ankle length of the better-visible leg. */
function estimateLegLength(frames: PoseFrame[]): number {
  const lengths = frames.map(({ pts }) => {
    const best = pts[L.leftKnee].v >= pts[L.rightKnee].v ? SIDE.left : SIDE.right;
    return dist(pts[best.hip], pts[best.knee]) + dist(pts[best.knee], pts[best.ankle]);
  });
  return median(lengths) || 1;
}

/** Indices of frames grouped by segment (runs of consecutive kept frames). */
function groupSegments(frames: PoseFrame[]): number[][] {
  const out: number[][] = [];
  frames.forEach((f, i) => {
    if (!out.length || frames[i - 1].segment !== f.segment) out.push([]);
    out[out.length - 1].push(i);
  });
  return out;
}

/**
 * In side view the model regularly swaps left/right labels as the legs cross.
 * If relabeling a pair matches the previous frame much better, swap it.
 */
function fixSwaps(frames: PoseFrame[], legLength: number) {
  const check = (prev: Pt[], cur: Pt[], pairs: [number, number][]) => {
    let same = 0, swapped = 0;
    for (const [l, r] of pairs) {
      same += dist(cur[l], prev[l]) + dist(cur[r], prev[r]);
      swapped += dist(cur[l], prev[r]) + dist(cur[r], prev[l]);
    }
    if (swapped < same * 0.5 && same > 0.15 * legLength * pairs.length) {
      for (const [l, r] of pairs) [cur[l], cur[r]] = [cur[r], cur[l]];
    }
  };
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].segment !== frames[i - 1].segment) continue;
    check(frames[i - 1].pts, frames[i].pts, LEG_PAIRS);
    check(frames[i - 1].pts, frames[i].pts, ARM_PAIRS);
  }
}

/**
 * Direction of travel for a segment where the runner crosses the frame (hips
 * move more than a leg length). Returns undefined for a stationary runner
 * (treadmill, or a panning camera), where the caller falls back to the
 * whole-clip facing vote.
 */
function segmentDirection(frames: PoseFrame[], idx: number[], legLength: number): 1 | -1 | undefined {
  const first = frames[idx[0]].pts, last = frames[idx[idx.length - 1]].pts;
  const hipShift = mid(last[L.leftHip], last[L.rightHip]).x - mid(first[L.leftHip], first[L.rightHip]).x;
  if (Math.abs(hipShift) > legLength) return hipShift > 0 ? 1 : -1;
  return undefined;
}

/** Facing vote: toes point forward and the nose is ahead of the ears. Positive = facing right. */
function facingVote(frames: PoseFrame[], idx: number[]): number {
  let vote = 0;
  for (const fi of idx) {
    const p = frames[fi].pts;
    for (const s of SIDES) {
      const f = SIDE[s];
      vote += (p[f.toe].x - p[f.heel].x) * Math.min(p[f.toe].v, p[f.heel].v);
    }
    const ears = mid(p[L.leftEar], p[L.rightEar]);
    vote += (p[L.nose].x - ears.x) * Math.min(p[L.nose].v, ears.v);
  }
  return vote;
}

/**
 * Ground line per frame: the lowest foot point over a sliding window of about
 * one stride, so it follows slow camera drift or a sloped view.
 */
function groundLine(frames: PoseFrame[], idx: number[], fps: number): number[] {
  const lows = idx.map((fi) => {
    const p = frames[fi].pts;
    let y = -Infinity;
    for (const s of SIDES) if (p[SIDE[s].ankle].v >= MIN_VIS) y = Math.max(y, footLow(p, s));
    return y;
  });
  const half = Math.max(3, Math.round(fps * 0.4));
  const fallback = Math.max(...lows.filter(Number.isFinite), 0);
  return lows.map((_, k) => {
    let y = -Infinity;
    for (let j = Math.max(0, k - half); j <= Math.min(lows.length - 1, k + half); j++) y = Math.max(y, lows[j]);
    return Number.isFinite(y) ? y : fallback;
  });
}

// ---------------------------------------------------------------- summary

export interface Summary {
  strikes: number;
  overstridePct: number;
  shin: number;
  reach: number;
  kneeFlex: number;
  footTypes: Record<Strike["footType"], number>;
  cadence: number | undefined;
  /** Median ground contact time in ms, overall and per side. */
  contactMs: number | undefined;
  contactMsBySide: Record<Side, number | undefined>;
  /** Median vertical oscillation per step, in leg lengths. */
  bounce: number | undefined;
  /** Mean ms from touchdown to the loaded frame (a mean, since at low fps most values are 0 or 1 frame). */
  timeToLoadMs: number | undefined;
  /** Median shin angle at the loaded frame. */
  shinAtLoad: number | undefined;
  hipExtension: number | undefined;
  swingKneeFlex: number | undefined;
  elbow: number;
  trunk: number;
}

const defined = (xs: (number | undefined)[]) => xs.filter((x): x is number => x !== undefined && Number.isFinite(x));
const meanOrUndef = (xs: (number | undefined)[]) => {
  const d = defined(xs);
  return d.length ? mean(d) : undefined;
};
const medianOrUndef = (xs: (number | undefined)[]) => {
  const d = defined(xs);
  return d.length ? median(d) : undefined;
};

export function summarize(frames: PoseFrame[], metrics: FrameMetrics[], strikes: Strike[]): Summary {
  // Cadence from stride time (same foot to same foot, same segment). This is
  // more robust than alternating-step intervals when the model mislabels a leg,
  // so step intervals are only a fallback for short clips.
  const strides: number[] = [];
  for (const side of SIDES) {
    const own = strikes.filter((s) => s.side === side);
    for (let i = 1; i < own.length; i++) {
      const a = own[i - 1], b = own[i];
      const dt = b.time - a.time;
      if (frames[a.frame].segment === frames[b.frame].segment && dt > 0.4 && dt < 1.6) strides.push(dt);
    }
  }
  const steps: number[] = [];
  for (let i = 1; i < strikes.length; i++) {
    const a = strikes[i - 1], b = strikes[i];
    const dt = b.time - a.time;
    if (frames[a.frame].segment === frames[b.frame].segment && a.side !== b.side && dt > 0.2 && dt < 0.8) steps.push(dt);
  }
  const cadence = strides.length >= 2 ? 120 / median(strides) : steps.length >= 2 ? 60 / median(steps) : undefined;

  const footTypes = { heel: 0, midfoot: 0, forefoot: 0 };
  strikes.forEach((s) => footTypes[s.footType]++);

  const elbows = defined(metrics.flatMap((m) => [m.elbow.left, m.elbow.right]));
  const trunks = defined(metrics.map((m) => m.trunkLean));
  const ms = (x: number | undefined) => (x === undefined ? undefined : x * 1000);

  return {
    strikes: strikes.length,
    overstridePct: strikes.length ? (100 * strikes.filter((s) => s.overstride).length) / strikes.length : 0,
    shin: mean(strikes.map((s) => s.shinAngle)),
    reach: mean(strikes.map((s) => s.reach)),
    kneeFlex: mean(strikes.map((s) => s.kneeFlexion)),
    footTypes,
    cadence,
    contactMs: ms(medianOrUndef(strikes.map((s) => s.contactTime))),
    contactMsBySide: {
      left: ms(medianOrUndef(strikes.filter((s) => s.side === "left").map((s) => s.contactTime))),
      right: ms(medianOrUndef(strikes.filter((s) => s.side === "right").map((s) => s.contactTime))),
    },
    bounce: medianOrUndef(strikes.map((s) => s.bounce)),
    timeToLoadMs: ms(meanOrUndef(strikes.map((s) => s.timeToLoad))),
    shinAtLoad: medianOrUndef(strikes.map((s) => s.shinAtLoad)),
    hipExtension: medianOrUndef(strikes.map((s) => s.hipExtension)),
    swingKneeFlex: medianOrUndef(strikes.map((s) => s.swingKneeFlex)),
    elbow: median(elbows),
    trunk: median(trunks),
  };
}
