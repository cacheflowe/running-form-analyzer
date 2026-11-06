// Frame-by-frame viewer for the kept frames: scrub, step, play in slow motion
// and jump between foot strikes. Frames are decoded from JPEG on demand and
// kept in a small LRU cache.

import { buildActiveStrikes, COLORS, drawFrame, hipTrail, outputSize, type ActiveStrike, type OverlayOptions } from "./overlay";
import type { Analysis } from "./types";

export interface ViewerElements {
  canvas: HTMLCanvasElement;
  timeline: HTMLCanvasElement;
  scrub: HTMLInputElement;
  playBtn: HTMLButtonElement;
}

const CACHE_SIZE = 48;

export class Viewer {
  index = 0;
  speed = 0.25;
  overlay: OverlayOptions = { angles: true, strikeGuides: true };
  onFrame?: (index: number) => void;

  readonly active: ActiveStrike[][];
  private cache = new Map<number, Promise<ImageBitmap>>();
  private ctx: CanvasRenderingContext2D;
  private playing = false;
  private raf = 0;
  private renderToken = 0;

  constructor(private el: ViewerElements, readonly a: Analysis) {
    this.ctx = el.canvas.getContext("2d")!;
    this.active = buildActiveStrikes(a.frames, a.metrics, a.strikes);

    el.scrub.max = String(Math.max(0, a.frames.length - 1));
    el.scrub.value = "0";
    el.scrub.oninput = () => {
      this.pause();
      this.seek(Number(el.scrub.value));
    };
    el.playBtn.onclick = () => this.toggle();
    el.timeline.onclick = (e) => {
      const rect = el.timeline.getBoundingClientRect();
      this.pause();
      this.seek(Math.round(((e.clientX - rect.left) / rect.width) * (a.frames.length - 1)));
    };
    new ResizeObserver(() => this.drawTimeline()).observe(el.timeline);
    this.enableDragScrub();
    this.seek(0);
  }

  /** Horizontal drag on the video steps through frames (handy on touch screens). */
  private enableDragScrub() {
    const c = this.el.canvas;
    let startX = 0;
    let startIndex = 0;
    let dragging = false;
    c.onpointerdown = (e) => {
      dragging = true;
      startX = e.clientX;
      startIndex = this.index;
      c.setPointerCapture(e.pointerId);
    };
    c.onpointermove = (e) => {
      if (!dragging) return;
      // ~1 frame per 10 CSS px, so fine steps are easy with a thumb
      const delta = Math.round((e.clientX - startX) / 10);
      if (delta !== 0 || this.index !== startIndex) {
        this.pause();
        if (startIndex + delta !== this.index) this.seek(startIndex + delta);
      }
    };
    c.onpointerup = c.onpointercancel = (e) => {
      // A tap without movement toggles playback
      if (dragging && Math.abs(e.clientX - startX) < 4 && e.type === "pointerup") this.toggle();
      dragging = false;
    };
  }

  destroy() {
    this.pause();
    for (const p of this.cache.values()) p.then((b) => b.close()).catch(() => {});
    this.cache.clear();
    this.el.scrub.oninput = null;
    this.el.playBtn.onclick = null;
    this.el.timeline.onclick = null;
    const c = this.el.canvas;
    c.onpointerdown = c.onpointermove = c.onpointerup = c.onpointercancel = null;
  }

  seek(i: number) {
    this.index = Math.max(0, Math.min(this.a.frames.length - 1, i));
    this.el.scrub.value = String(this.index);
    void this.render();
    this.drawTimeline();
    this.onFrame?.(this.index);
  }

  step(delta: number) {
    this.pause();
    this.seek(this.index + delta);
  }

  /**
   * Jump to the next (+1) or previous (-1) key frame: each strike's touchdown,
   * then its loaded frame when that's a later frame.
   */
  jumpStrike(dir: 1 | -1) {
    this.pause();
    const keys = [...new Set(this.a.strikes.flatMap((s) => [s.frame, s.loadFrame ?? s.frame]))].sort((a, b) => a - b);
    const target = dir > 0 ? keys.find((k) => k > this.index) : keys.reverse().find((k) => k < this.index);
    if (target !== undefined) this.seek(target);
  }

  redraw() {
    void this.render();
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  play() {
    if (this.playing || this.a.frames.length < 2) return;
    if (this.index >= this.a.frames.length - 1) this.seek(0);
    this.playing = true;
    this.el.playBtn.innerHTML = `⏸<span class="lbl"> Pause</span>`;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      if (!this.playing) return;
      acc += ((now - last) / 1000) * this.speed;
      last = now;
      let advanced = false;
      // Advance by source frame durations, so playback runs at real (scaled) speed
      while (acc >= this.a.frames[this.index].duration) {
        acc -= this.a.frames[this.index].duration;
        if (this.index >= this.a.frames.length - 1) {
          this.index = 0; // loop
        } else this.index++;
        advanced = true;
      }
      if (advanced) this.seek(this.index);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.el.playBtn.innerHTML = `▶<span class="lbl"> Play</span>`;
  }

  /** Decoded bitmap for frame i (cached). */
  bitmap(i: number): Promise<ImageBitmap> {
    let p = this.cache.get(i);
    if (p) {
      // refresh LRU position
      this.cache.delete(i);
      this.cache.set(i, p);
      return p;
    }
    p = createImageBitmap(this.a.frames[i].image);
    this.cache.set(i, p);
    while (this.cache.size > CACHE_SIZE) {
      const [oldest, op] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      op.then((b) => b.close()).catch(() => {});
    }
    return p;
  }

  private async render() {
    const token = ++this.renderToken;
    const i = this.index;
    const bmp = await this.bitmap(i);
    // Prefetch ahead so playback stays smooth
    for (let k = 1; k <= 6 && i + k < this.a.frames.length; k++) void this.bitmap(i + k);
    if (token !== this.renderToken) return; // a newer frame was requested meanwhile
    const f = this.a.frames[i];
    const size = outputSize(this.a.width, this.a.height, this.overlay);
    if (this.el.canvas.width !== size.width) this.el.canvas.width = size.width;
    if (this.el.canvas.height !== size.height) this.el.canvas.height = size.height;
    drawFrame(this.ctx, bmp, f, this.a.metrics[i], this.active[i], {
      ...this.overlay,
      trail: this.overlay.showTrail ? hipTrail(this.a.frames, i) : undefined,
      hud: `${f.time.toFixed(3)} s · frame ${i + 1}/${this.a.frames.length}`,
    });
  }

  /** Segments as bars, strikes as ticks (left above, right below), playhead. */
  drawTimeline() {
    const c = this.el.timeline;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext("2d")!;
    const n = this.a.frames.length;
    const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * (w - 2 * dpr) + dpr);
    ctx.clearRect(0, 0, w, h);

    // Segment bars, alternating shade so cuts are visible
    const mid = h / 2;
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i === n || this.a.frames[i].segment !== this.a.frames[start].segment) {
        ctx.fillStyle = this.a.frames[start].segment % 2 ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.28)";
        ctx.fillRect(x(start), mid - 3 * dpr, Math.max(dpr, x(i - 1) - x(start)), 6 * dpr);
        start = i;
      }
    }

    for (const s of this.a.strikes) {
      ctx.fillStyle = s.overstride ? COLORS.bad : s.side === "left" ? COLORS.left : COLORS.right;
      const top = s.side === "left";
      ctx.fillRect(x(s.frame) - dpr, top ? 2 * dpr : mid + 5 * dpr, 2 * dpr, mid - 7 * dpr);
      // Loaded frame: a dot at the tick's outer end
      if (s.loadFrame !== undefined && s.loadFrame !== s.frame) {
        ctx.beginPath();
        ctx.arc(x(s.loadFrame), top ? 4 * dpr : h - 4 * dpr, 2.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.fillStyle = "#fff";
    ctx.fillRect(x(this.index) - dpr, 0, 2 * dpr, h);
  }
}
