import "./style.css";
import { exportAnnotatedVideo } from "./exportVideo";
import { extractPoseFrames, probeVideo } from "./extract";
import { analyzeForm, LEG_FRACTION_OF_HEIGHT, rate, summarize } from "./metrics";
import { ratingColor, type OverlayOptions } from "./overlay";
import { computeCrop } from "./crop";
import { listCameras, openCamera, startRecording, type Recording } from "./recorder";
import type { Analysis, Rating, Side, Strike } from "./types";
import type { PoseModel } from "./pose";
import { Viewer } from "./viewer";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  fileInput: $<HTMLInputElement>("file-input"),
  dropZone: $<HTMLLabelElement>("drop-zone"),
  cameraPreview: $<HTMLVideoElement>("camera-preview"),
  cameraSelect: $<HTMLSelectElement>("camera-select"),
  cameraBtn: $<HTMLButtonElement>("camera-btn"),
  recordBtn: $<HTMLButtonElement>("record-btn"),
  recIndicator: $<HTMLSpanElement>("rec-indicator"),
  modeUpload: $<HTMLButtonElement>("mode-upload"),
  modeCamera: $<HTMLButtonElement>("mode-camera"),
  recorder: $<HTMLDivElement>("recorder"),
  timescaleSelect: $<HTMLSelectElement>("timescale-select"),
  heightInput: $<HTMLInputElement>("height-input"),
  showTrail: $<HTMLInputElement>("show-trail"),
  modelSelect: $<HTMLSelectElement>("model-select"),
  resSelect: $<HTMLSelectElement>("res-select"),
  analyzeBtn: $<HTMLButtonElement>("analyze-btn"),
  cancelBtn: $<HTMLButtonElement>("cancel-btn"),
  sourceInfo: $<HTMLSpanElement>("source-info"),
  progress: $<HTMLProgressElement>("analyze-progress"),
  status: $<HTMLParagraphElement>("status"),
  results: $<HTMLElement>("results-section"),
  viewerCanvas: $<HTMLCanvasElement>("viewer-canvas"),
  timeline: $<HTMLCanvasElement>("timeline-canvas"),
  scrub: $<HTMLInputElement>("scrub"),
  playBtn: $<HTMLButtonElement>("play-btn"),
  prevFrame: $<HTMLButtonElement>("prev-frame"),
  nextFrame: $<HTMLButtonElement>("next-frame"),
  prevStrike: $<HTMLButtonElement>("prev-strike"),
  nextStrike: $<HTMLButtonElement>("next-strike"),
  speedSelect: $<HTMLSelectElement>("speed-select"),
  showAngles: $<HTMLInputElement>("show-angles"),
  showStrike: $<HTMLInputElement>("show-strike"),
  frameInfo: $<HTMLParagraphElement>("frame-info"),
  frameMetrics: $<HTMLDivElement>("frame-metrics"),
  summaryMetrics: $<HTMLDivElement>("summary-metrics"),
  cropToggle: $<HTMLInputElement>("crop-toggle"),
  exportSpeed: $<HTMLSelectElement>("export-speed"),
  exportHold: $<HTMLSelectElement>("export-hold"),
  exportStrikesOnly: $<HTMLInputElement>("export-strikes-only"),
  exportBtn: $<HTMLButtonElement>("export-btn"),
  exportProgress: $<HTMLProgressElement>("export-progress"),
  exportResult: $<HTMLDivElement>("export-result"),
  exportVideo: $<HTMLVideoElement>("export-video"),
  exportLink: $<HTMLAnchorElement>("export-link"),
};

let sourceFile: File | null = null;
let analysis: Analysis | null = null;
let viewer: Viewer | null = null;
let abort: AbortController | null = null;
let exportUrl: string | null = null;

const setStatus = (msg: string, isError = false) => {
  ui.status.textContent = msg;
  ui.status.classList.toggle("error", isError);
};

// ---------------------------------------------------------------- source: upload

async function setSource(file: File) {
  sourceFile = file;
  ui.analyzeBtn.disabled = false;
  ui.sourceInfo.textContent = file.name;
  setStatus("");
  try {
    const info = await probeVideo(file);
    ui.sourceInfo.textContent = `${file.name} · ${info.width}×${info.height} · ${info.fps.toFixed(0)} fps · ${info.duration.toFixed(1)} s`;
    if (info.fps < 50) setStatus("Tip: this clip is under 50 fps — foot-strike timing will be approximate. Slow-mo footage gives better results.");
  } catch (err) {
    setStatus(`Couldn't read this video: ${(err as Error).message}`, true);
    ui.analyzeBtn.disabled = true;
  }
}

ui.fileInput.addEventListener("change", () => {
  const f = ui.fileInput.files?.[0];
  if (f) void setSource(f);
});
ui.dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  ui.dropZone.classList.add("dragging");
});
ui.dropZone.addEventListener("dragleave", () => ui.dropZone.classList.remove("dragging"));
ui.dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  ui.dropZone.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("video/")) void setSource(f);
  else if (f) setStatus("That doesn't look like a video file.", true);
});

// ---------------------------------------------------------------- source: camera

let stream: MediaStream | null = null;
let recording: Recording | null = null;
let recTimer = 0;

async function startCamera(deviceId?: string) {
  stopCamera();
  try {
    stream = await openCamera(deviceId);
  } catch (err) {
    setStatus(`Camera unavailable: ${(err as Error).message}`, true);
    return;
  }
  ui.cameraPreview.srcObject = stream;
  await ui.cameraPreview.play().catch(() => {});
  ui.cameraBtn.textContent = "Stop camera";
  ui.recordBtn.disabled = false;

  // Labels are only available after permission is granted
  const cams = await listCameras();
  const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
  ui.cameraSelect.innerHTML = cams.map((c, i) => `<option value="${c.deviceId}">${escapeHtml(c.label || `Camera ${i + 1}`)}</option>`).join("");
  if (current) ui.cameraSelect.value = current;
  const s = stream.getVideoTracks()[0]?.getSettings();
  if (s) setStatus(`Camera: ${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)} fps`);
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ui.cameraPreview.srcObject = null;
  ui.cameraBtn.textContent = "Start camera";
  ui.recordBtn.disabled = true;
}

/** Upload and camera share the source panel; only one is shown at a time. */
function setSourceMode(mode: "upload" | "camera") {
  if (recording) return; // don't yank the camera mid-recording
  const camera = mode === "camera";
  ui.modeUpload.setAttribute("aria-selected", String(!camera));
  ui.modeCamera.setAttribute("aria-selected", String(camera));
  ui.dropZone.hidden = camera;
  ui.recorder.hidden = !camera;
  if (camera && !stream) void startCamera();
  if (!camera) stopCamera();
}
ui.modeUpload.addEventListener("click", () => setSourceMode("upload"));
ui.modeCamera.addEventListener("click", () => setSourceMode("camera"));

ui.cameraBtn.addEventListener("click", () => {
  if (recording) return;
  if (stream) stopCamera();
  else void startCamera();
});
ui.cameraSelect.addEventListener("change", () => {
  if (stream && !recording) void startCamera(ui.cameraSelect.value);
});

ui.recordBtn.addEventListener("click", async () => {
  if (!stream) return;
  if (!recording) {
    try {
      recording = await startRecording(stream);
    } catch (err) {
      setStatus(`Recording failed: ${(err as Error).message}`, true);
      return;
    }
    ui.recordBtn.textContent = "Stop";
    ui.recordBtn.classList.add("recording");
    ui.cameraBtn.disabled = true;
    ui.recIndicator.hidden = false;
    const tick = () => {
      const secs = (performance.now() - recording!.startedAt) / 1000;
      ui.recIndicator.textContent = `● REC ${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}`;
    };
    tick();
    recTimer = window.setInterval(tick, 250);
    return;
  }

  clearInterval(recTimer);
  ui.recordBtn.disabled = true;
  try {
    const file = await recording.stop();
    await setSource(file);
    setStatus(`Recorded ${file.name}. Ready to analyze.`);
  } catch (err) {
    setStatus(`Recording failed: ${(err as Error).message}`, true);
  } finally {
    recording = null;
    ui.recIndicator.hidden = true;
    ui.recordBtn.textContent = "Record";
    ui.recordBtn.classList.remove("recording");
    ui.recordBtn.disabled = !stream;
    ui.cameraBtn.disabled = false;
  }
});

// ---------------------------------------------------------------- analysis


ui.analyzeBtn.addEventListener("click", async () => {
  if (!sourceFile) return;
  abort = new AbortController();
  ui.analyzeBtn.disabled = true;
  ui.cancelBtn.hidden = false;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  setStatus("Loading pose model…");
  const started = performance.now();

  try {
    const res = await extractPoseFrames(sourceFile, {
      model: ui.modelSelect.value as PoseModel,
      maxShortEdge: Number(ui.resSelect.value),
      slowdown: Number(ui.timescaleSelect.value),
      signal: abort.signal,
      onProgress: ({ fraction, scanned, kept }) => {
        ui.progress.value = fraction;
        setStatus(`Detecting poses… ${Math.round(fraction * 100)}% · ${scanned} frames scanned · ${kept} kept`);
      },
    });
    if (abort.signal.aborted) {
      setStatus("Analysis cancelled.");
      return;
    }
    if (!res.frames.length) {
      setStatus(`No runner detected in ${res.scanned} frames. Try a clearer side view with the legs in frame.`, true);
      return;
    }

    const form = analyzeForm(res.frames, res.fps);
    analysis = { ...res, ...form, fileName: sourceFile.name, crop: computeCrop(res.frames, form.metrics, res.width, res.height) };
    if (import.meta.env.DEV) (window as unknown as { analysis: Analysis }).analysis = analysis; // for console debugging
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    setStatus(
      `Kept ${res.frames.length} of ${res.scanned} frames · ${form.strikes.length} foot strikes found · ${secs} s` +
        slowMoHint(analysis),
    );
    showResults(analysis);
  } catch (err) {
    console.error(err);
    setStatus(`Analysis failed: ${(err as Error).message}`, true);
  } finally {
    ui.analyzeBtn.disabled = false;
    ui.cancelBtn.hidden = true;
    ui.progress.hidden = true;
    abort = null;
  }
});

ui.cancelBtn.addEventListener("click", () => abort?.abort());

// ---------------------------------------------------------------- results

/**
 * Real ground contact is ~150–350 ms. Much longer means the file is probably
 * slowed-down slow-mo whose timestamps don't reflect real time.
 */
function slowMoHint(a: Analysis): string {
  const s = summarize(a.frames, a.metrics, a.strikes);
  if (Number(ui.timescaleSelect.value) === 1 && s.contactMs !== undefined && s.contactMs > 600) {
    const factor = s.contactMs > 1600 ? 8 : s.contactMs > 900 ? 4 : 2;
    return ` · Ground contact looks ${Math.round(s.contactMs)} ms, which suggests slowed-down footage. Try Footage speed “Slowed ${factor}×” and re-analyze.`;
  }
  return "";
}

/** Overlay options from the view toggles; shared by the viewer and the export. */
function overlayOptions(a: Analysis): OverlayOptions {
  return {
    angles: ui.showAngles.checked,
    strikeGuides: ui.showStrike.checked,
    showTrail: ui.showTrail.checked,
    crop: ui.cropToggle.checked ? a.crop : undefined,
  };
}

/** Converts leg lengths to cm when the runner's height is known. */
function legsToCm(legs: number | undefined): number | undefined {
  const h = Number(ui.heightInput.value);
  if (legs === undefined || !(h >= 100 && h <= 230)) return undefined;
  return legs * h * LEG_FRACTION_OF_HEIGHT;
}
/** "0.12 leg" or "0.12 leg · 10 cm". */
function fmtLegs(legs: number | undefined) {
  if (legs === undefined || Number.isNaN(legs)) return "–";
  const cm = legsToCm(legs);
  return cm === undefined ? `${legs.toFixed(2)} leg` : `${cm.toFixed(0)} cm`;
}

function showResults(a: Analysis) {
  viewer?.destroy();
  ui.results.hidden = false;
  ui.exportResult.hidden = true;
  ui.cropToggle.parentElement!.hidden = !a.crop;

  viewer = new Viewer({ canvas: ui.viewerCanvas, timeline: ui.timeline, scrub: ui.scrub, playBtn: ui.playBtn }, a);
  viewer.speed = Number(ui.speedSelect.value);
  viewer.overlay = overlayOptions(a);
  viewer.onFrame = (i) => updateFrameMetrics(a, i);
  renderSummary(a);
  viewer.redraw();
  updateFrameMetrics(a, 0);
  ui.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

ui.prevFrame.addEventListener("click", () => viewer?.step(-1));
ui.nextFrame.addEventListener("click", () => viewer?.step(1));
ui.prevStrike.addEventListener("click", () => viewer?.jumpStrike(-1));
ui.nextStrike.addEventListener("click", () => viewer?.jumpStrike(1));
ui.speedSelect.addEventListener("change", () => viewer && (viewer.speed = Number(ui.speedSelect.value)));
for (const box of [ui.showAngles, ui.showStrike, ui.showTrail, ui.cropToggle]) {
  box.addEventListener("change", () => {
    if (!viewer || !analysis) return;
    viewer.overlay = overlayOptions(analysis);
    viewer.redraw();
  });
}
// Height only changes unit conversion, so results update without re-analyzing
ui.heightInput.addEventListener("input", () => {
  if (!analysis || !viewer) return;
  renderSummary(analysis);
  updateFrameMetrics(analysis, viewer.index);
});

document.addEventListener("keydown", (e) => {
  if (!viewer || ui.results.hidden) return;
  const tag = (e.target as HTMLElement).tagName;
  if (tag === "INPUT" && (e.target as HTMLInputElement).type !== "range") return;
  if (tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "ArrowLeft") e.shiftKey ? viewer.jumpStrike(-1) : viewer.step(-1);
  else if (e.key === "ArrowRight") e.shiftKey ? viewer.jumpStrike(1) : viewer.step(1);
  else if (e.key === " ") viewer.toggle();
  else return;
  e.preventDefault();
});

const fmt = (n: number | undefined, unit = "°", digits = 0) => (n === undefined || Number.isNaN(n) ? "–" : `${n.toFixed(digits)}${unit}`);
const sideName = (s: Side) => (s === "left" ? "L" : "R");

function metric(label: string, value: string, rating?: Rating, hint?: string) {
  const color = rating ? ` style="color:${ratingColor(rating)}"` : "";
  return `<div class="metric"><span class="k">${label}${hint ? ` <span class="hint">${hint}</span>` : ""}</span><span class="v"${color}>${value}</span></div>`;
}

function updateFrameMetrics(a: Analysis, i: number) {
  const m = a.metrics[i];
  const f = a.frames[i];
  ui.frameInfo.textContent = `Source ${f.time.toFixed(3)} s · frame ${i + 1}/${a.frames.length} · moving ${m.dir > 0 ? "→" : "←"}`;

  let html = "";
  for (const side of ["left", "right"] as Side[]) {
    const e = m.elbow[side];
    html += metric(`${sideName(side)} elbow`, fmt(e), e !== undefined ? rate.elbow(e) : undefined);
  }
  for (const side of ["left", "right"] as Side[]) {
    html += metric(`${sideName(side)} knee`, fmt(m.knee[side]), undefined, m.contact[side] ? "ground" : "");
  }
  html += metric("Lean", fmt(m.trunkLean), m.trunkLean !== undefined ? rate.trunk(m.trunkLean) : undefined);

  // Strike details stay visible while that foot is on the ground
  const shown = viewer?.active[i] ?? [];
  for (const { strike } of shown) html += strikeMetrics(strike, a.strikes.indexOf(strike));
  ui.frameMetrics.innerHTML = html;
}

function strikeMetrics(s: Strike, n: number) {
  const side = s.side === "left" ? "Left" : "Right";
  return (
    `<div class="strike-head" style="color:${ratingColor(s.overstride ? "bad" : "good")}">#${n + 1} ${side} foot strike · ${s.overstride ? "Overstriding" : "Landing under body"}</div>` +
    metric("Foot", `${s.footType} ${fmt(s.footAngle)}`, rate.foot(s.footType)) +
    metric("Shin", fmt(s.shinAngle), rate.shin(s.shinAngle), "vs vertical") +
    metric("Reach", fmtLegs(s.reach), rate.reach(s.reach), "ahead of hip") +
    metric("Knee bend", fmt(s.kneeFlexion), rate.kneeFlexAtContact(s.kneeFlexion)) +
    (s.timeToLoad !== undefined ? metric("To loaded", fmtLoad(s.timeToLoad * 1000), undefined, "after touchdown") : "") +
    (s.shinAtLoad !== undefined && s.loadFrame !== s.frame ? metric("Shin at load", fmt(s.shinAtLoad), rate.shin(s.shinAtLoad)) : "") +
    (s.contactTime !== undefined ? metric("Contact", `${Math.round(s.contactTime * 1000)} ms`) : "") +
    (s.hipExtension !== undefined ? metric("Hip ext.", fmt(s.hipExtension), undefined, "at toe-off") : "") +
    (s.swingKneeFlex !== undefined ? metric("Heel recovery", fmt(s.swingKneeFlex), undefined, "peak knee bend") : "") +
    (s.bounce !== undefined ? metric("Bounce", fmtLegs(s.bounce), rate.bounce(s.bounce), "this step") : "")
  );
}

function renderSummary(a: Analysis) {
  const s = summarize(a.frames, a.metrics, a.strikes);
  const ft = s.footTypes;
  ui.summaryMetrics.innerHTML = s.strikes
    ? metric("Foot strikes", String(s.strikes)) +
      metric("Overstriding", `${Math.round(s.overstridePct)}%`, s.overstridePct < 20 ? "good" : s.overstridePct < 50 ? "warn" : "bad") +
      metric("Avg shin", fmt(s.shin), rate.shin(s.shin)) +
      metric("Avg reach", fmtLegs(s.reach), rate.reach(s.reach)) +
      metric("Avg knee bend", fmt(s.kneeFlex), rate.kneeFlexAtContact(s.kneeFlex), "at contact") +
      metric("Foot strike", `${ft.heel} heel · ${ft.midfoot} mid · ${ft.forefoot} fore`) +
      metric("Cadence", s.cadence ? `${Math.round(s.cadence)} spm` : "–", s.cadence ? (s.cadence >= 165 ? "good" : s.cadence >= 150 ? "warn" : "bad") : undefined) +
      metric("Bounce", fmtLegs(s.bounce), s.bounce !== undefined ? rate.bounce(s.bounce) : undefined, "vertical oscillation") +
      metric("To loaded", fmtLoad(s.timeToLoadMs), undefined, "touchdown → weight on foot") +
      metric("Shin at load", fmt(s.shinAtLoad), s.shinAtLoad !== undefined ? rate.shin(s.shinAtLoad) : undefined) +
      metric("Ground contact", fmtMs(s.contactMs), undefined, contactSplit(s.contactMsBySide)) +
      metric("Hip extension", fmt(s.hipExtension), undefined, "at toe-off") +
      metric("Heel recovery", fmt(s.swingKneeFlex), undefined, "peak swing knee bend") +
      metric("Typical elbow", fmt(s.elbow), Number.isNaN(s.elbow) ? undefined : rate.elbow(s.elbow)) +
      metric("Typical lean", fmt(s.trunk), Number.isNaN(s.trunk) ? undefined : rate.trunk(s.trunk))
    : `<p class="muted">No foot strikes detected. The runner may need to be filmed from the side with feet in frame.</p>`;
}

const fmtMs = (ms: number | undefined) => (ms === undefined ? "–" : `${Math.round(ms)} ms`);
/** Time from touchdown to the loaded frame; 0 means the same frame. */
const fmtLoad = (ms: number | undefined) => (ms === undefined ? "–" : ms < 1 ? "same frame" : fmtMs(ms));
/** "L 210 · R 240" when both sides were measured, to spot asymmetry. */
function contactSplit(by: Record<Side, number | undefined>) {
  return by.left !== undefined && by.right !== undefined ? `L ${Math.round(by.left)} · R ${Math.round(by.right)}` : "";
}

// ---------------------------------------------------------------- export

/** The last rendered clip, kept as a File so it can go to the share sheet. */
let exportFile: File | null = null;

/**
 * On phones/tablets that can share files (iOS Safari, Android Chrome), the
 * share sheet is the way to get a video into the photo library ("Save Video"
 * on iOS); a plain download lands in Files instead. Desktop keeps downloading.
 */
function canShareFile(file: File) {
  return (
    matchMedia("(pointer: coarse)").matches &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] })
  );
}

ui.exportLink.addEventListener("click", (e) => {
  if (!exportFile || !canShareFile(exportFile)) return; // normal download
  e.preventDefault();
  // Call share() synchronously in the click so the user gesture is still valid
  navigator.share({ files: [exportFile], title: exportFile.name }).catch((err: DOMException) => {
    if (err.name === "AbortError") return; // user closed the sheet
    console.warn("Share failed, falling back to download:", err);
    const a = document.createElement("a");
    a.href = ui.exportLink.href;
    a.download = ui.exportLink.download;
    a.click();
  });
});

ui.exportBtn.addEventListener("click", async () => {
  if (!analysis) return;
  if (abort) return;
  viewer?.pause();
  abort = new AbortController();
  ui.exportBtn.disabled = true;
  ui.exportProgress.hidden = false;
  ui.exportProgress.value = 0;
  try {
    const { blob, ext } = await exportAnnotatedVideo(analysis, {
      speed: Number(ui.exportSpeed.value),
      hold: Number(ui.exportHold.value),
      strikesOnly: ui.exportStrikesOnly.checked,
      overlay: overlayOptions(analysis),
      signal: abort.signal,
      onProgress: (p) => (ui.exportProgress.value = p),
    });
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(blob);
    ui.exportVideo.src = exportUrl;
    ui.exportLink.href = exportUrl;
    const base = analysis.fileName.replace(/\.[^.]+$/, "");
    ui.exportLink.download = `${base}-form.${ext}`;
    exportFile = new File([blob], ui.exportLink.download, { type: blob.type });
    const size = `${(blob.size / 1e6).toFixed(1)} MB`;
    ui.exportLink.textContent = canShareFile(exportFile) ? `Save / Share (${size})` : `Download ${ext.toUpperCase()} (${size})`;
    ui.exportResult.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${(err as Error).message}`, true);
  } finally {
    ui.exportBtn.disabled = false;
    ui.exportProgress.hidden = true;
    abort = null;
  }
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
