// MediaPipe pose landmark indices (33-point BlazePose topology).
// "left"/"right" are the runner's own left and right, not the image's.
export const L = {
  nose: 0,
  leftEar: 7,
  rightEar: 8,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftToe: 31,
  rightToe: 32,
} as const;

export const SIDE = {
  left: {
    shoulder: L.leftShoulder,
    elbow: L.leftElbow,
    wrist: L.leftWrist,
    hip: L.leftHip,
    knee: L.leftKnee,
    ankle: L.leftAnkle,
    heel: L.leftHeel,
    toe: L.leftToe,
  },
  right: {
    shoulder: L.rightShoulder,
    elbow: L.rightElbow,
    wrist: L.rightWrist,
    hip: L.rightHip,
    knee: L.rightKnee,
    ankle: L.rightAnkle,
    heel: L.rightHeel,
    toe: L.rightToe,
  },
} as const;

/** Body connections (face omitted) tagged by side for coloring. */
export const BONES: [number, number, "left" | "right" | "center"][] = [
  [L.leftShoulder, L.rightShoulder, "center"],
  [L.leftHip, L.rightHip, "center"],
  [L.leftShoulder, L.leftHip, "left"],
  [L.rightShoulder, L.rightHip, "right"],
  [L.leftShoulder, L.leftElbow, "left"],
  [L.leftElbow, L.leftWrist, "left"],
  [L.rightShoulder, L.rightElbow, "right"],
  [L.rightElbow, L.rightWrist, "right"],
  [L.leftHip, L.leftKnee, "left"],
  [L.leftKnee, L.leftAnkle, "left"],
  [L.leftAnkle, L.leftHeel, "left"],
  [L.leftHeel, L.leftToe, "left"],
  [L.leftAnkle, L.leftToe, "left"],
  [L.rightHip, L.rightKnee, "right"],
  [L.rightKnee, L.rightAnkle, "right"],
  [L.rightAnkle, L.rightHeel, "right"],
  [L.rightHeel, L.rightToe, "right"],
  [L.rightAnkle, L.rightToe, "right"],
];

/** Left/right landmark pairs that get relabeled together when the model swaps legs or arms. */
export const LEG_PAIRS: [number, number][] = [
  [L.leftKnee, L.rightKnee],
  [L.leftAnkle, L.rightAnkle],
  [L.leftHeel, L.rightHeel],
  [L.leftToe, L.rightToe],
];
export const ARM_PAIRS: [number, number][] = [
  [L.leftElbow, L.rightElbow],
  [L.leftWrist, L.rightWrist],
];
