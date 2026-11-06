// Renders the kept frames with their overlay into a new video with Mediabunny.

import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from "mediabunny";
import { buildActiveStrikes, drawFrame, hipTrail, outputSize, type OverlayOptions } from "./overlay";
import type { Analysis } from "./types";

export interface ExportOptions {
  /** Playback speed relative to real time (0.25 = 4× slow motion). */
  speed: number;
  /** Seconds to freeze on each touchdown and loaded frame. */
  hold: number;
  /** Only include a short window around each strike. */
  strikesOnly: boolean;
  overlay: OverlayOptions;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface ExportResult {
  blob: Blob;
  ext: "mp4" | "webm";
}

/** Shortest frame duration we'll write, so very high-fps sources still play back smoothly. */
const MIN_FRAME_DURATION = 1 / 120;

export async function exportAnnotatedVideo(a: Analysis, opts: ExportOptions): Promise<ExportResult> {
  const indices = opts.strikesOnly ? framesAroundStrikes(a, 0.12, 0.25) : a.frames.map((_, i) => i);
  if (!indices.length) throw new Error("No frames to export.");

  const { width, height } = outputSize(a.width, a.height, opts.overlay);
  const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1", "vp8"], { width, height });
  if (!codec) throw new Error("This browser can't encode video at this size.");
  const isMp4 = codec === "avc" || codec === "av1";

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  const target = new BufferTarget();
  const output = new Output({
    format: isMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target,
  });
  const source = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(source);
  await output.start();

  const active = buildActiveStrikes(a.frames, a.metrics, a.strikes);
  // Pause on each touchdown and on its loaded frame
  const strikeFrames = new Set(a.strikes.flatMap((s) => [s.frame, s.loadFrame ?? s.frame]));
  let t = 0;
  let pendingDur = 0;

  try {
    for (let k = 0; k < indices.length; k++) {
      if (opts.signal?.aborted) {
        await output.cancel();
        throw new DOMException("Export cancelled", "AbortError");
      }
      const i = indices[k];
      const f = a.frames[i];
      const bmp = await createImageBitmap(f.image);
      drawFrame(ctx, bmp, f, a.metrics[i], active[i], {
        ...opts.overlay,
        trail: opts.overlay.showTrail ? hipTrail(a.frames, i) : undefined,
        hud: `${f.time.toFixed(2)} s${opts.speed !== 1 ? ` · ${1 / opts.speed}× slow-mo` : ""}`,
      });
      bmp.close();

      // At high fps / low slow-mo, drop frames that would be shorter than
      // MIN_FRAME_DURATION by folding their time into the next written frame.
      const dur = f.duration / opts.speed + pendingDur;
      const hold = strikeFrames.has(i) ? opts.hold : 0;
      if (dur < MIN_FRAME_DURATION && !hold && k < indices.length - 1) {
        pendingDur = dur;
        continue;
      }
      pendingDur = 0;
      await source.add(t, dur + hold);
      t += dur + hold;
      opts.onProgress?.((k + 1) / indices.length);
    }
    source.close();
    await output.finalize();
  } catch (err) {
    if (output.state !== "canceled" && output.state !== "finalized") await output.cancel().catch(() => {});
    throw err;
  }

  return {
    blob: new Blob([target.buffer!], { type: isMp4 ? "video/mp4" : "video/webm" }),
    ext: isMp4 ? "mp4" : "webm",
  };
}

/** Frame indices within [before, after] seconds of any strike (same segment). */
function framesAroundStrikes(a: Analysis, before: number, after: number): number[] {
  const keep = new Set<number>();
  for (const s of a.strikes) {
    const seg = a.frames[s.frame].segment;
    a.frames.forEach((f, i) => {
      if (f.segment === seg && f.time >= s.time - before && f.time <= s.time + after) keep.add(i);
    });
  }
  return [...keep].sort((x, y) => x - y);
}
