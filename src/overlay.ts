// Draws a frame with its pose skeleton, joint angles and foot-strike guides.
// Used by both the interactive viewer and the video export so they match.

import { BONES, L, SIDE } from "./landmarks";
import { mid, rate } from "./metrics";
import type { FrameMetrics, PoseFrame, Pt, Rating, Side, Strike } from "./types";

export const COLORS = {
  left: "#4fc3f7",
  right: "#ffb74d",
  center: "#f5f5f5",
  good: "#66bb6a",
  warn: "#ffca28",
  bad: "#ef5350",
  ground: "rgba(255,255,255,0.35)",
};

export interface OverlayOptions {
  angles: boolean;
  strikeGuides: boolean;
  /** Text drawn in the bottom-left corner (time, frame count). */
  hud?: string;
  /** Vertical crop of the source frame; the canvas should be crop.h tall. */
  crop?: { y: number; h: number };
  /** Whether callers should supply `trail` (see hipTrail). */
  showTrail?: boolean;
  /** Recent hip-center positions (oldest first), drawn as a fading path. */
  trail?: { x: number; y: number }[];
}

/** Hip-center path over the last `seconds` within the same segment, oldest first. */
export function hipTrail(frames: PoseFrame[], i: number, seconds = 0.7): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const seg = frames[i].segment;
  const t0 = frames[i].time - seconds;
  for (let j = i; j >= 0 && frames[j].segment === seg && frames[j].time >= t0; j--) {
    const p = frames[j].pts;
    out.push(mid(p[L.leftHip], p[L.rightHip]));
  }
  return out.reverse();
}

/** Canvas size for a frame of the given analysis size and overlay options. */
export function outputSize(width: number, height: number, opts: Pick<OverlayOptions, "crop">) {
  return { width, height: opts.crop?.h ?? height };
}

/** A strike to visualize, plus how many frames have passed since touchdown. */
export interface ActiveStrike {
  strike: Strike;
  /** Pose at the moment of touchdown (guides are drawn from it). */
  pts: Pt[];
  framesSince: number;
}

const MIN_VIS = 0.3;

export function drawFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  frame: PoseFrame,
  m: FrameMetrics,
  active: ActiveStrike[],
  opts: OverlayOptions,
) {
  const { width: w, height: h } = ctx.canvas;
  const s = Math.max(1, Math.min(w, h) / 540); // scale factor for strokes and text
  const oy = opts.crop?.y ?? 0;
  ctx.drawImage(image, 0, oy, w, h, 0, 0, w, h);

  // Darken slightly so the overlay pops
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, 0, w, h);

  // Pose layer is in source-frame coordinates; shift it into the crop
  ctx.save();
  ctx.translate(0, -oy);
  drawPose(ctx, frame, m, active, opts, s, w);
  ctx.restore();

  // Banner for the most recent strike
  const banner = active.find((a) => a.framesSince === 0) ?? active.find(isLoadFrame) ?? active[0];
  if (opts.strikeGuides && banner) drawBanner(ctx, banner, s, w);

  if (opts.hud) label(ctx, opts.hud, 10 * s, h - 10 * s, "rgba(0,0,0,0.6)", "#fff", s, "left", "bottom");
}

function drawPose(ctx: Ctx, frame: PoseFrame, m: FrameMetrics, active: ActiveStrike[], opts: OverlayOptions, s: number, w: number) {
  const pts = frame.pts;

  // Ground line
  dashed(ctx, [0, m.groundY], [w, m.groundY], COLORS.ground, 1.5 * s, [8 * s, 6 * s]);

  if (opts.trail && opts.trail.length > 1) drawTrail(ctx, opts.trail, s);

  // Strike guides first so the skeleton sits on top
  if (opts.strikeGuides) for (const a of active) drawStrikeGuides(ctx, a, m, s);

  // Loaded frame: the foot is pressed down and carrying weight
  const loaded = opts.strikeGuides ? active.find(isLoadFrame) : undefined;
  if (loaded) drawLoadMarker(ctx, pts, loaded.strike, m, s);

  // Skeleton
  ctx.lineCap = "round";
  for (const [a, b, side] of BONES) {
    const pa = pts[a], pb = pts[b];
    if (pa.v < MIN_VIS || pb.v < MIN_VIS) continue;
    ctx.globalAlpha = Math.min(1, 0.35 + Math.min(pa.v, pb.v));
    line(ctx, pa, pb, COLORS[side], 4 * s);
  }
  ctx.globalAlpha = 1;

  // Feet in contact with the ground get a green sole
  for (const side of ["left", "right"] as Side[]) {
    if (!m.contact[side]) continue;
    const f = SIDE[side];
    if (pts[f.heel].v < MIN_VIS) continue;
    line(ctx, pts[f.heel], pts[f.toe], COLORS.good, 7 * s);
  }

  // Joints
  for (const [i, color] of jointColors()) {
    const p = pts[i];
    if (p.v < MIN_VIS) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5 * s, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = "#000";
    ctx.stroke();
  }
  if (pts[L.nose].v >= MIN_VIS) {
    ctx.beginPath();
    ctx.arc(pts[L.nose].x, pts[L.nose].y, 6 * s, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.center;
    ctx.fill();
  }

  if (opts.angles) {
    for (const side of ["left", "right"] as Side[]) {
      const f = SIDE[side];
      const elbow = m.elbow[side];
      if (elbow !== undefined) {
        angleArc(ctx, pts[f.shoulder], pts[f.elbow], pts[f.wrist], `${Math.round(elbow)}°`, ratingColor(rate.elbow(elbow)), s);
      }
      const knee = m.knee[side];
      if (knee !== undefined) {
        angleArc(ctx, pts[f.hip], pts[f.knee], pts[f.ankle], `${Math.round(knee)}°`, COLORS[side], s);
      }
    }
    drawTrunk(ctx, pts, m, s);
  }
}

function jointColors(): [number, string][] {
  const out: [number, string][] = [];
  for (const side of ["left", "right"] as Side[]) {
    const f = SIDE[side];
    for (const i of [f.shoulder, f.elbow, f.wrist, f.hip, f.knee, f.ankle, f.heel, f.toe]) out.push([i, COLORS[side]]);
  }
  return out;
}

function drawTrail(ctx: Ctx, trail: { x: number; y: number }[], s: number) {
  ctx.save();
  ctx.lineCap = "round";
  for (let k = 1; k < trail.length; k++) {
    ctx.globalAlpha = (k / trail.length) * 0.9;
    line(ctx, trail[k - 1], trail[k], "#e1bee7", 3 * s);
  }
  // Mark the highest and lowest points so the bounce range is easy to read
  let hi = trail[0], lo = trail[0];
  for (const p of trail) {
    if (p.y < hi.y) hi = p;
    if (p.y > lo.y) lo = p;
  }
  ctx.globalAlpha = 0.9;
  for (const p of [hi, lo]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5 * s, 0, Math.PI * 2);
    ctx.fillStyle = "#e1bee7";
    ctx.fill();
  }
  ctx.restore();
}

function drawTrunk(ctx: Ctx, pts: Pt[], m: FrameMetrics, s: number) {
  if (m.trunkLean === undefined) return;
  const sh = mid(pts[L.leftShoulder], pts[L.rightShoulder]);
  const hip = mid(pts[L.leftHip], pts[L.rightHip]);
  const len = Math.hypot(sh.x - hip.x, sh.y - hip.y);
  dashed(ctx, [hip.x, hip.y], [hip.x, hip.y - len], "rgba(255,255,255,0.5)", 1.5 * s, [4 * s, 4 * s]);
  line(ctx, hip, sh, COLORS.center, 2.5 * s);
  const color = ratingColor(rate.trunk(m.trunkLean));
  label(ctx, `Lean ${Math.round(m.trunkLean)}°`, sh.x + m.dir * 14 * s, (sh.y + hip.y) / 2, "rgba(0,0,0,0.65)", color, s, m.dir > 0 ? "left" : "right", "middle");
}

function drawStrikeGuides(ctx: Ctx, a: ActiveStrike, m: FrameMetrics, s: number) {
  const { strike, pts } = a;
  const f = SIDE[strike.side];
  const knee = pts[f.knee], ankle = pts[f.ankle], heel = pts[f.heel], toe = pts[f.toe];
  const hipC = mid(pts[L.leftHip], pts[L.rightHip]);
  const ground = m.groundY;
  ctx.save();
  ctx.globalAlpha = a.framesSince === 0 ? 1 : 0.55;

  // Plumb line from the hip: where the foot "should" land under
  dashed(ctx, [hipC.x, hipC.y], [hipC.x, ground], COLORS.center, 2 * s, [6 * s, 5 * s]);

  // Reach: horizontal distance from the hip plumb line to the ankle
  const reachColor = ratingColor(rate.reach(strike.reach));
  const y = ground + 14 * s;
  line(ctx, { x: hipC.x, y }, { x: ankle.x, y }, reachColor, 4 * s);
  for (const x of [hipC.x, ankle.x]) line(ctx, { x, y: y - 7 * s }, { x, y: y + 7 * s }, reachColor, 3 * s);
  label(ctx, `Reach ${strike.reach.toFixed(2)} leg`, (hipC.x + ankle.x) / 2, y + 10 * s, "rgba(0,0,0,0.7)", reachColor, s, "center", "top");

  // Shin angle vs vertical, measured at the knee
  const shinColor = ratingColor(rate.shin(strike.shinAngle));
  const shinLen = Math.hypot(ankle.x - knee.x, ankle.y - knee.y);
  dashed(ctx, [knee.x, knee.y], [knee.x, knee.y + shinLen * 1.1], "rgba(255,255,255,0.7)", 1.5 * s, [4 * s, 4 * s]);
  line(ctx, knee, ankle, shinColor, 6 * s);
  const down = Math.PI / 2;
  const shinDir = Math.atan2(ankle.y - knee.y, ankle.x - knee.x);
  ctx.beginPath();
  ctx.arc(knee.x, knee.y, shinLen * 0.45, Math.min(down, shinDir), Math.max(down, shinDir));
  ctx.strokeStyle = shinColor;
  ctx.lineWidth = 2.5 * s;
  ctx.stroke();
  const dirSign = Math.sign(ankle.x - knee.x) || 1;
  label(ctx, `Shin ${Math.round(strike.shinAngle)}°`, knee.x + dirSign * 12 * s, knee.y + shinLen * 0.5, "rgba(0,0,0,0.7)", shinColor, s, dirSign > 0 ? "left" : "right", "middle");

  // Foot angle
  if (heel.v >= MIN_VIS && toe.v >= MIN_VIS) {
    const footColor = ratingColor(rate.foot(strike.footType));
    const dx = toe.x - heel.x, dy = toe.y - heel.y;
    dashed(ctx, [heel.x - dx * 0.4, heel.y - dy * 0.4], [toe.x + dx * 0.6, toe.y + dy * 0.6], footColor, 2 * s, [3 * s, 3 * s]);
  }
  ctx.restore();
}

/** The loaded frame of a strike (weight on the foot), when it comes after touchdown. */
function isLoadFrame(a: ActiveStrike) {
  const { strike } = a;
  return strike.loadFrame !== undefined && strike.loadFrame !== strike.frame && a.framesSince === strike.loadFrame - strike.frame;
}

/** Bar under the loaded foot, plus the time since touchdown and the shin angle now. */
function drawLoadMarker(ctx: Ctx, pts: Pt[], strike: Strike, m: FrameMetrics, s: number) {
  const f = SIDE[strike.side];
  const heel = pts[f.heel], toe = pts[f.toe], knee = pts[f.knee], ankle = pts[f.ankle];
  const y = m.groundY + 3 * s;
  ctx.save();
  line(ctx, { x: heel.x, y }, { x: toe.x, y }, "#ce93d8", 6 * s);
  const ms = Math.round((strike.timeToLoad ?? 0) * 1000);
  const shin = strike.shinAtLoad !== undefined ? ` · shin ${Math.round(strike.shinAtLoad)}°` : "";
  const dirSign = Math.sign(toe.x - heel.x) || 1;
  const x = dirSign > 0 ? Math.max(heel.x, toe.x) + 10 * s : Math.min(heel.x, toe.x) - 10 * s;
  label(ctx, `Loaded +${ms} ms${shin}`, x, y - 8 * s, "rgba(0,0,0,0.75)", "#ce93d8", s, dirSign > 0 ? "left" : "right", "bottom");
  // Shin now, so the change from touchdown (strike guide) is visible
  if (strike.shinAtLoad !== undefined) line(ctx, knee, ankle, "#ce93d8", 3 * s);
  ctx.restore();
}

function drawBanner(ctx: Ctx, a: ActiveStrike, s: number, w: number) {
  const { strike } = a;
  const side = strike.side === "left" ? "LEFT" : "RIGHT";
  if (isLoadFrame(a)) {
    const ms = Math.round((strike.timeToLoad ?? 0) * 1000);
    label(ctx, `${side} FOOT · Loaded (weight on foot) +${ms} ms after touchdown`, w / 2, 12 * s, "rgba(0,0,0,0.75)", "#ce93d8", s * 1.15, "center", "top");
    return;
  }
  const foot = { heel: "Heel strike", midfoot: "Midfoot strike", forefoot: "Forefoot strike" }[strike.footType];
  const verdict = strike.overstride ? "OVERSTRIDE" : "Foot under body";
  const color = strike.overstride ? COLORS.bad : COLORS.good;
  label(ctx, `${side} FOOT · ${foot} (${Math.round(strike.footAngle)}°) · knee ${Math.round(strike.kneeFlexion)}° bent · ${verdict}`, w / 2, 12 * s, "rgba(0,0,0,0.75)", color, s * 1.15, "center", "top");
}

// ---------------------------------------------------------------- primitives

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function ratingColor(r: Rating) {
  return COLORS[r];
}

function line(ctx: Ctx, a: { x: number; y: number }, b: { x: number; y: number }, color: string, width: number) {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.stroke();
}

function dashed(ctx: Ctx, a: [number, number], b: [number, number], color: string, width: number, dash: number[]) {
  ctx.save();
  ctx.setLineDash(dash);
  line(ctx, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }, color, width);
  ctx.restore();
}

/** Arc showing the interior angle at b, with a label outside the joint. */
function angleArc(ctx: Ctx, a: Pt, b: Pt, c: Pt, text: string, color: string, s: number) {
  const a1 = Math.atan2(a.y - b.y, a.x - b.x);
  const a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let diff = a2 - a1;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const r = 16 * s;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.arc(b.x, b.y, r, a1, a1 + diff, diff < 0);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.25);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * s;
  ctx.stroke();

  // Label on the opposite side of the bisector, outside the angle
  const bis = a1 + diff / 2 + Math.PI;
  const lx = b.x + Math.cos(bis) * (r + 16 * s);
  const ly = b.y + Math.sin(bis) * (r + 16 * s);
  label(ctx, text, lx, ly, "rgba(0,0,0,0.65)", color, s, "center", "middle");
}

function label(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  bg: string,
  fg: string,
  s: number,
  align: "left" | "center" | "right",
  baseline: "top" | "middle" | "bottom",
) {
  const size = Math.round(13 * s);
  ctx.font = `600 ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
  const pad = 4 * s;
  const tw = ctx.measureText(text).width;
  const bw = tw + pad * 2, bh = size + pad * 2;
  const bx = align === "left" ? x : align === "center" ? x - bw / 2 : x - bw;
  const by = baseline === "top" ? y : baseline === "middle" ? y - bh / 2 : y - bh;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4 * s);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + pad, by + bh / 2 + 0.5);
}

function withAlpha(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * For each frame, the strikes to visualize: a strike stays "active" from
 * touchdown while that foot remains on the ground.
 */
export function buildActiveStrikes(frames: PoseFrame[], metrics: FrameMetrics[], strikes: Strike[]): ActiveStrike[][] {
  const out: ActiveStrike[][] = frames.map(() => []);
  for (const strike of strikes) {
    const seg = frames[strike.frame].segment;
    const pts = frames[strike.frame].pts.map((p) => ({ ...p }));
    for (let i = strike.frame; i < frames.length && frames[i].segment === seg; i++) {
      if (i > strike.frame && !metrics[i].contact[strike.side]) break;
      out[i].push({ strike, pts, framesSince: i - strike.frame });
    }
  }
  return out;
}
