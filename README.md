# Running Form Analyzer

Browser-only running gait analysis. Record or upload a side-view clip. The app
keeps only the frames where a pose is detected, draws the skeleton with joint
angles, finds each foot strike, and flags overstriding. You can scrub through
the kept frames or render an annotated clip.

- **Vite** dev server and build (static, deploys to GitHub Pages)
- **MediaPipe Pose Landmarker** (`@mediapipe/tasks-vision`, VIDEO mode, GPU with CPU fallback)
- **Mediabunny** for frame decoding (`CanvasSink`), camera recording
  (`MediaStreamVideoTrackSource`) and MP4/WebM export (`CanvasSource`)

## Develop

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # type-check + build to dist/
npm run update-libs
```

Camera access needs `localhost` or HTTPS.

## Deploy

`.github/workflows/deploy-pages.yml` builds and deploys `dist/` on every push to
`main`. In the repo settings, set **Pages → Source** to **GitHub Actions**. The
build uses a relative base, so it works from any subpath.

## How it works

| File | Role |
| --- | --- |
| `src/extract.ts` | Decode frames → detect pose → keep frames where the near leg (hip, knee, ankle) is clearly seen. Each frame is also flagged when the body from shoulders to feet is inside the frame (head and hands may be cut off; toes may poke just past the edge); only those frames can count as a foot strike. Kept frames are stored as JPEG blobs to keep memory low. |
| `src/metrics.ts` | Fix left/right leg swaps, find the direction of travel, estimate the ground line, detect ground contact per foot, and measure each initial contact. All coaching thresholds live in `rate`. |
| `src/overlay.ts` | Draws the skeleton, angle arcs, ground line and strike guides. Shared by the viewer and the export. |
| `src/viewer.ts` | Scrubber, slow-motion playback, strike-to-strike stepping, timeline. |
| `src/exportVideo.ts` | Renders the annotated frames with Mediabunny (speed, pause on strike, strikes-only). |
| `src/recorder.ts` | Camera capture straight to MP4 (requests up to 120 fps). |

### Strike metrics

Each metric is measured at the first frame a foot is judged to be on the ground:

- **Shin angle**: knee→ankle line vs vertical. Positive means the ankle lands ahead of the knee. Above ~10° suggests overstriding.
- **Reach**: horizontal ankle distance ahead of the hip center, in leg lengths. Above ~0.3 suggests overstriding.
- **Knee bend**: flexion at contact. A nearly straight knee (<8°) means braking.
- **Foot angle**: heel→toe line vs horizontal. Classified as heel, midfoot or forefoot.
- **Summary**: cadence (from same-foot stride time), ground contact time, typical elbow angle and trunk lean.

### Limitations

These are 2D measurements from a single camera, so they're a guide, not a lab
result. Accuracy depends on:

- a level, side-on, still camera
- the body from shoulders to feet in frame (strikes are skipped otherwise)
- a high frame rate (≥120 fps is ideal; at 30 fps contact timing is approximate)

The far-side leg is often partly hidden, so its strikes are less reliable.
