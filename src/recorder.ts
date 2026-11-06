// Camera recording straight to MP4 with Mediabunny's MediaStream source (same
// approach as media-converter's screen capture). MediaRecorder's WebM has no
// duration or seek index, which makes frame-accurate decoding harder.

import {
  BufferTarget,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from "mediabunny";

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "videoinput");
}

/** Opens a camera, preferring a high frame rate (better for catching foot strike). */
export async function openCamera(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 120 },
    },
  });
}

export interface Recording {
  stop(): Promise<File>;
  readonly startedAt: number;
}

export async function startRecording(stream: MediaStream): Promise<Recording> {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("No camera track.");
  const settings = track.getSettings();
  const width = even(settings.width ?? 1280);
  const height = even(settings.height ?? 720);
  const fps = settings.frameRate ?? 30;

  const codec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1", "vp8"], { width, height });
  if (!codec) throw new Error("This browser can't encode video from this camera.");
  const isMp4 = codec === "avc" || codec === "av1";

  const target = new BufferTarget();
  const output = new Output({
    format: isMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
    target,
  });
  const source = new MediaStreamVideoTrackSource(
    track as MediaStreamVideoTrack,
    {
      codec,
      bitrate: QUALITY_VERY_HIGH,
      contentHint: "motion",
      sizeChangeBehavior: "contain",
      ...(width !== settings.width || height !== settings.height ? { transform: { width, height, fit: "contain" as const } } : {}),
    },
  );
  output.addVideoTrack(source, { frameRate: fps });
  source.errorPromise.catch((err) => console.error("Recording error:", err));
  await output.start();
  const startedAt = performance.now();

  return {
    startedAt,
    async stop() {
      await output.finalize();
      const buffer = target.buffer;
      if (!buffer) throw new Error("Recording was empty.");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      return new File([buffer], `run-${stamp}.${isMp4 ? "mp4" : "webm"}`, { type: isMp4 ? "video/mp4" : "video/webm" });
    },
  };
}
