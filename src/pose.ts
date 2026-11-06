// MediaPipe Pose Landmarker setup.
//
// The wasm runtime is imported with `?url`, so Vite copies it out of
// node_modules into the build. That keeps the wasm in lockstep with the npm
// package version and avoids a CDN dependency. The .task model files are
// fetched from Google's model bucket on first use (the browser caches them).

import { PoseLandmarker } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

export type PoseModel = "lite" | "full" | "heavy";

const modelUrl = (m: PoseModel) =>
  `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

let cached: { model: PoseModel; landmarker: PoseLandmarker } | null = null;

/**
 * Returns a VIDEO-mode landmarker for the chosen model, reusing the previous
 * instance when the model hasn't changed. VIDEO mode tracks the pose between
 * frames, which is steadier than detecting each frame independently, but
 * requires strictly increasing timestamps, so callers that start a new pass
 * should call `resetPoseLandmarker()` first.
 */
export async function getPoseLandmarker(model: PoseModel): Promise<PoseLandmarker> {
  if (cached?.model === model) return cached.landmarker;
  cached?.landmarker.close();
  cached = null;

  // Explicit paths instead of FilesetResolver.forVisionTasks(cdnUrl)
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const options = (delegate: "GPU" | "CPU") => ({
    baseOptions: { modelAssetPath: modelUrl(model), delegate },
    runningMode: "VIDEO" as const,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  let landmarker: PoseLandmarker;
  try {
    landmarker = await PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch (err) {
    console.warn("GPU delegate unavailable, falling back to CPU:", err);
    landmarker = await PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
  cached = { model, landmarker };
  return landmarker;
}

/** Drops the cached landmarker so the next pass starts with fresh tracking state and timestamps. */
export function resetPoseLandmarker() {
  cached?.landmarker.close();
  cached = null;
}
