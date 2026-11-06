/** A landmark in frame pixel space (y points down). `v` is MediaPipe's visibility score, 0–1. */
export interface Pt {
  x: number;
  y: number;
  z: number;
  v: number;
}

/** A source frame where a usable pose was detected. */
export interface PoseFrame {
  /** Timestamp in the source video, seconds. */
  time: number;
  /** Frame duration in the source video, seconds. */
  duration: number;
  /** JPEG of the decoded frame at analysis resolution. */
  image: Blob;
  /** 33 MediaPipe pose landmarks, in pixels. */
  pts: Pt[];
  /** Index of the run of consecutive kept frames this frame belongs to. */
  segment: number;
  /** Shoulders to feet (both sides) inside the frame; required to count a foot strike. */
  fullBody: boolean;
}

export type Side = "left" | "right";
export type Rating = "good" | "warn" | "bad";

/** Metrics measured on a single frame. Angles in degrees; undefined when the joints aren't visible. */
export interface FrameMetrics {
  /** +1 = runner moving toward the right of the frame, -1 = toward the left. */
  dir: 1 | -1;
  elbow: Record<Side, number | undefined>;
  knee: Record<Side, number | undefined>;
  /** Forward lean of the trunk from vertical (positive = leaning forward). */
  trunkLean: number | undefined;
  /** Whether each foot is judged to be on the ground. */
  contact: Record<Side, boolean>;
  /** Estimated ground line y (pixels) for this frame. */
  groundY: number;
}

/** Measurements at the moment a foot first touches down. */
export interface Strike {
  frame: number;
  side: Side;
  time: number;
  /** Shin angle from vertical; positive = ankle landing ahead of the knee. */
  shinAngle: number;
  /** Foot angle vs ground; positive = toes up (heel first). */
  footAngle: number;
  footType: "heel" | "midfoot" | "forefoot";
  /** Horizontal distance from hip to ankle at landing, in leg lengths (positive = ahead of hip). */
  reach: number;
  /** Knee flexion at contact (0 = straight leg). */
  kneeFlexion: number;
  overstride: boolean;
  /** Last frame this foot is on the ground (when it leaves the ground in view). */
  toeOffFrame?: number;
  /** Seconds from touchdown to toe-off. */
  contactTime?: number;
  /** Thigh angle behind vertical at toe-off (positive = pushed back). */
  hipExtension?: number;
  /** Peak knee bend during the swing that follows (heel recovery). */
  swingKneeFlex?: number;
  /** Hip center rise-and-fall over the step to the next strike, in leg lengths. */
  bounce?: number;
}

export interface Analysis {
  width: number;
  height: number;
  /** Estimated source frame rate. */
  fps: number;
  /** Number of frames decoded from the source. */
  scanned: number;
  frames: PoseFrame[];
  metrics: FrameMetrics[];
  strikes: Strike[];
  /** Median hip-to-ankle length in pixels, used to normalize distances. */
  legLength: number;
  fileName: string;
  /** Vertical crop around the runner, if it saves meaningful space. */
  crop?: { y: number; h: number };
}
