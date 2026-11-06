// Decodes every frame of a video with Mediabunny, runs the pose landmarker on
// it, and keeps only the frames where the runner's legs are clearly detected.
//
// Kept frames are stored as JPEG blobs rather than bitmaps: a few hundred
// 1080p bitmaps would need gigabytes of memory, while JPEGs are ~100–200 KB
// each and decode in a few milliseconds when the viewer needs them.

import { ALL_FORMATS, BlobSource, CanvasSink, Input } from "mediabunny";
import { getPoseLandmarker, resetPoseLandmarker, type PoseModel } from "./pose";
import type { PoseFrame, Pt } from "./types";
import { L } from "./landmarks";

export interface ExtractOptions {
  model: PoseModel;
  /** Target short-edge size in pixels; 0 keeps the source size. */
  maxShortEdge: number;
  /**
   * How much the footage is slowed down (e.g. 8 for a 240 fps slow-mo that was
   * exported to play at 30 fps). Timestamps are divided by this so all timing
   * metrics come out in real time.
   */
  slowdown?: number;
  signal?: AbortSignal;
  onProgress?: (p: { fraction: number; scanned: number; kept: number }) => void;
}

export interface ExtractResult {
  frames: PoseFrame[];
  width: number;
  height: number;
  fps: number;
  scanned: number;
}

export interface SourceInfo {
  width: number;
  height: number;
  duration: number;
  fps: number;
  codec: string | null;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function probeVideo(file: Blob): Promise<SourceInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track found in this file.");
    const stats = await track.computePacketStats(120);
    return {
      width: track.displayWidth,
      height: track.displayHeight,
      duration: await track.computeDuration(),
      fps: stats.averagePacketRate,
      codec: track.codec,
    };
  } finally {
    input.dispose();
  }
}

/**
 * Joints that must be in frame to count a foot strike: shoulders, hips, knees
 * and ankles on both sides. The head and hands are left out — a head cropped
 * at the top of a portrait clip or an arm swinging out of frame doesn't affect
 * the leg measurements.
 */
const JOINTS = [
  L.leftShoulder, L.rightShoulder, L.leftHip, L.rightHip,
  L.leftKnee, L.rightKnee, L.leftAnkle, L.rightAnkle,
];
const FEET = [L.leftHeel, L.rightHeel, L.leftToe, L.rightToe];
/**
 * How far (fraction of the frame) landmarks may sit past the edges. MediaPipe
 * places a point slightly outside the image when it's right at the edge, and in
 * portrait clips a toe or heel often pokes just past the side. Joints get only
 * a sliver of horizontal slack, so a runner partly out of the frame at the side
 * still isn't counted.
 */
const JOINT_SLACK_X = 0.01;
const JOINT_SLACK_Y = 0.05;
const FOOT_SLACK = 0.08;

/** Minimum visibility for the leg nearest the camera. */
const MIN_NEAR_LEG_VISIBILITY = 0.5;

/**
 * Enough of the body to keep the frame: the hip, knee and ankle of the leg
 * nearest the camera are confidently seen (mean visibility, best side). Such
 * frames feed the viewer, ground-line and contact tracking even when the head
 * or an arm is cut off.
 */
export function enoughBody(pts: { visibility?: number }[]): boolean {
  const v = (i: number) => pts[i]?.visibility ?? 0;
  const left = (v(L.leftHip) + v(L.leftKnee) + v(L.leftAnkle)) / 3;
  const right = (v(L.rightHip) + v(L.rightKnee) + v(L.rightAnkle)) / 3;
  return Math.max(left, right) >= MIN_NEAR_LEG_VISIBILITY;
}

/**
 * Body in frame: shoulders, hips, knees and ankles on both sides are inside the
 * image (with a little slack), and the heels and toes are at most just past the
 * edge. Required for a frame to count as a foot strike. Positions are checked
 * rather than visibility, since in a side view the far limbs are legitimately
 * hidden behind the body.
 */
export function wholeBodyInFrame(pts: { x: number; y: number }[]): boolean {
  const inside = (i: number, sx: number, sy: number) => {
    const p = pts[i];
    return !!p && p.x >= -sx && p.x <= 1 + sx && p.y >= -sy && p.y <= 1 + sy;
  };
  return JOINTS.every((i) => inside(i, JOINT_SLACK_X, JOINT_SLACK_Y)) && FEET.every((i) => inside(i, FOOT_SLACK, FOOT_SLACK));
}

export async function extractPoseFrames(file: Blob, opts: ExtractOptions): Promise<ExtractResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track found in this file.");
    if (!(await track.canDecode())) {
      throw new Error(`This browser can't decode this video (codec: ${track.codec ?? "unknown"}).`);
    }

    const duration = await track.computeDuration();
    const slowdown = opts.slowdown && opts.slowdown > 0 ? opts.slowdown : 1;
    const fileFps = (await track.computePacketStats(120)).averagePacketRate || 30;
    const fps = fileFps * slowdown; // real-time capture rate

    // displayWidth/Height already account for rotation metadata (phone videos)
    const srcW = track.displayWidth;
    const srcH = track.displayHeight;
    const scale = opts.maxShortEdge > 0 ? Math.min(1, opts.maxShortEdge / Math.min(srcW, srcH)) : 1;
    const width = even(srcW * scale);
    const height = even(srcH * scale);

    // Fresh landmarker so VIDEO-mode tracking and timestamps start clean
    resetPoseLandmarker();
    const landmarker = await getPoseLandmarker(opts.model);

    const sink = new CanvasSink(track, { width, height, fit: "fill", poolSize: 2 });
    const frames: PoseFrame[] = [];
    let scanned = 0;
    let firstTs: number | null = null;
    let lastMs = -1;
    let segment = 0;
    let lastKeptScan = -2;

    for await (const { canvas, timestamp, duration: frameDur } of sink.canvases()) {
      if (opts.signal?.aborted) break;
      scanned++;

      firstTs ??= timestamp;
      // Real-time timestamps: MediaPipe's landmark smoothing is time-based, so
      // stretched slow-mo timestamps would over-smooth (and lag) fast motion.
      let ms = Math.round(((timestamp - firstTs) / slowdown) * 1000);
      if (ms <= lastMs) ms = lastMs + 1; // VIDEO mode needs strictly increasing timestamps
      lastMs = ms;

      const result = landmarker.detectForVideo(canvas, ms);
      const lm = result.landmarks[0];

      if (lm && enoughBody(lm)) {
        // A real gap in kept frames starts a new segment (e.g. runner left the
        // frame). A few dropped frames (~0.1 s) are bridged so a brief detection
        // flicker doesn't split a stride.
        const maxGap = Math.max(3, Math.round(fps * 0.1));
        if (scanned - lastKeptScan > maxGap && frames.length > 0) segment++;
        lastKeptScan = scanned;

        const pts: Pt[] = lm.map((p) => ({ x: p.x * width, y: p.y * height, z: p.z, v: p.visibility ?? 1 }));
        frames.push({
          time: timestamp / slowdown,
          duration: (frameDur || 1 / fileFps) / slowdown,
          image: await canvasToJpeg(canvas),
          pts,
          segment,
          fullBody: wholeBodyInFrame(lm),
        });
      }
      result.close();

      opts.onProgress?.({
        fraction: duration > 0 ? Math.min(1, (timestamp - (firstTs ?? 0)) / duration) : 0,
        scanned,
        kept: frames.length,
      });
    }

    return { frames, width, height, fps, scanned };
  } finally {
    input.dispose();
  }
}

function canvasToJpeg(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/jpeg", quality: 0.88 });
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("JPEG encode failed"))), "image/jpeg", 0.88),
  );
}
