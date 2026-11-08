// Renders each frame: live video + (costume + world) revealed inside the hand window.
// Work happens in raw (un-mirrored) camera coordinates; the final blit mirrors + crops.
import { makeRig, CHARACTERS } from "./costumes.js";
import { palmOpen } from "./gestures.js";

const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// ---------- photo backgrounds shown behind the hero inside the window ----------
export const BACKGROUNDS = {
  nyc: "assets/backgrounds/nyc-night.jpg",
  corridor: "assets/backgrounds/scifi-corridor.jpg",
  reactor: "assets/backgrounds/reactor.jpg",
};
const photos = {};
for (const [k, src] of Object.entries(BACKGROUNDS)) { const i = new Image(); i.src = src; photos[k] = i; }

// cover-fit the photo to the frame. The frame is drawn mirrored at the end, so pre-mirror the photo to keep it the right way round.
function makeWorld(kind, W, H) {
  const img = photos[kind];
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = canvas(W, H), g = c.getContext("2d");
  const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s;
  g.translate(W, 0); g.scale(-1, 1);
  g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  return c;
}

function halftone(step) {
  const c = canvas(step, step), g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, step, step);
  g.fillStyle = "rgba(40,0,60,.22)"; g.beginPath(); g.arc(step / 2, step / 2, step * 0.22, 0, Math.PI * 2); g.fill();
  return c;
}

// ---------- geometry ----------
function hull(pts) {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

function path(g, pts) { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) g.lineTo(p.x, p.y); g.closePath(); }

export class Compositor {
  constructor(out) {
    this.out = out; this.octx = out.getContext("2d");
    this.quad = null;     // smoothed window corners (raw px)
    this.open = 0;        // 0 closed … 1 fully open
    this.full = 0;        // full-suit blend
    this.worldKind = null; this.world = null;
  }

  resize(vw, vh, format) {
    const scale = Math.min(1, 960 / vw);
    this.W = Math.round(vw * scale); this.H = Math.round(vh * scale);
    this.raw = canvas(this.W, this.H); this.r = this.raw.getContext("2d");
    this.suit = canvas(this.W, this.H); this.s = this.suit.getContext("2d");
    this.scene = canvas(this.W, this.H); this.sc = this.scene.getContext("2d");
    this.setFormat(format); this.worldKind = null; this.tiny = null;
  }

  setFormat(format) {
    this.format = format;
    this.out.width = format === "9:16" ? Math.round(this.H * 9 / 16) : this.W;
    this.out.height = this.H;
  }

  // hands -> target window quad (raw px), or null if both palms aren't up
  _targetQuad(hands) {
    if (hands.length < 2) return null;
    const [a, b] = hands.map(h => h.map(p => ({ x: p.x * this.W, y: p.y * this.H })))
      .sort((p, q) => p[0].x - q[0].x);
    if (!palmOpen(hands[0]) || !palmOpen(hands[1])) return null;
    // top edge a little above the fingertips, bottom edge a little below the wrist
    const top = h => lerpPt(h[0], lerpPt(h[8], h[12], 0.5), 1.15);
    const bot = h => lerpPt(lerpPt(h[8], h[12], 0.5), h[0], 1.12);
    return [top(a), top(b), bot(b), bot(a)];
  }

  _buildSuit(video, tracker, ch) {
    const g = this.s, W = this.W, H = this.H;
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.filter = "none";

    const rig = makeRig(tracker, W, H);
    ch.paint(g, rig);
    // fabric: carry the real lighting / folds of your clothes onto the suit
    // blurred so folds + lighting carry over but shirt prints / facial features don't
    const bl = Math.max(3, Math.round(W * 0.007));
    g.globalCompositeOperation = "multiply"; g.globalAlpha = ch.shade;
    g.filter = `grayscale(1) blur(${bl}px) contrast(1.25) brightness(1.5)`;
    g.drawImage(video, 0, 0, W, H);
    if (ch.metal) {
      g.globalCompositeOperation = "screen"; g.globalAlpha = 0.4;
      g.filter = `grayscale(1) blur(${bl * 1.5}px) contrast(3.2) brightness(.55)`;
      g.drawImage(video, 0, 0, W, H);
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.filter = "none";
    ch.overlay(g, rig);
    // keep only the person
    g.globalCompositeOperation = "destination-in"; g.filter = "blur(2px)";
    g.drawImage(tracker.person.c, 0, 0, W, H);
    g.globalCompositeOperation = "source-over"; g.filter = "none";
  }

  render(video, tracker, opts, dt) {
    const { W, H, r } = this;
    const ch = CHARACTERS[opts.character];
    // "auto" = this hero's own scene; photo worlds may still be loading, so keep retrying until ready
    const kind = opts.world === "auto" ? (ch.scene || "blur") : opts.world;
    if (this.worldKind !== kind || (!this.world && BACKGROUNDS[kind])) { this.worldKind = kind; this.world = makeWorld(kind, W, H); }

    // --- window state
    const target = this._targetQuad(tracker.hands);
    if (target) this.quad = this.quad ? this.quad.map((p, i) => lerpPt(p, target[i], 0.55)) : target;
    const k = 1 - Math.pow(0.001, dt / 1000);                    // frame-rate independent easing
    this.open += ((target && opts.mode === "window" ? 1 : 0) - this.open) * Math.min(1, k * 4);
    this.full += ((opts.mode === "full" ? 1 : 0) - this.full) * Math.min(1, k * 3);

    r.drawImage(video, 0, 0, W, H);
    const showWindow = this.open > 0.02 && this.quad;
    const showFull = this.full > 0.02;

    // real hero photo that follows your head (null for drawn heroes or when you're not tracked)
    // 3D model (follows your whole upper body) > photo (follows your head) > drawn suit
    const live = ch.avatar || ch.tex;
    const hero = (showWindow || showFull) && live ? live.render(tracker, W, H) : null;

    if ((showWindow || showFull) && (hero || tracker.maskReady)) {
      const sc = this.sc;
      if (hero) {
        // background behind the hero: a photo world, your plain room, or your room blurred + darkened
        if (this.world) sc.drawImage(this.world, 0, 0, W, H);
        else if (kind === "room") sc.drawImage(video, 0, 0, W, H);
        else {
          // cheap blur: shrink the frame a lot, then scale it back up smoothly
          if (!this.tiny) { this.tiny = canvas(Math.ceil(W / 16), Math.ceil(H / 16)); }
          this.tiny.getContext("2d").drawImage(video, 0, 0, this.tiny.width, this.tiny.height);
          sc.imageSmoothingQuality = "high"; sc.drawImage(this.tiny, 0, 0, W, H);
          sc.fillStyle = "rgba(0,0,0,.35)"; sc.fillRect(0, 0, W, H);
        }
        sc.drawImage(hero, 0, 0);
      } else {
        // drawn suit painted onto you
        this._buildSuit(video, tracker, ch);
        sc.drawImage(this.world || video, 0, 0, W, H);
        sc.drawImage(this.suit, 0, 0);
      }

      if (showFull) {
        // full suit sweeps in from the top
        const y = H * this.full;
        r.save(); r.beginPath(); r.rect(0, 0, W, y); r.clip(); r.drawImage(this.scene, 0, 0); r.restore();
        if (this.full < 0.98) this._edgeLine([{ x: 0, y }, { x: W, y }], ch);
      }

      if (showWindow) {
        const c = this.quad.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
        const e = 1 - Math.pow(1 - this.open, 3);
        const q = this.quad.map(p => lerpPt(c, p, e));
        r.save(); path(r, q); r.clip(); r.drawImage(this.scene, 0, 0);
        if (!hero) {
          // comic-book halftone for the drawn suits only (real photos stay clean)
          if (!this.dots) this.dots = r.createPattern(halftone(Math.max(5, Math.round(W / 140))), "repeat");
          r.globalCompositeOperation = "multiply"; r.fillStyle = this.dots; r.fillRect(0, 0, W, H);
          r.globalCompositeOperation = "source-over";
        }
        r.restore();
        // your real hands stay in front of the window
        for (const hand of tracker.hands) {
          const pts = hand.map(p => ({ x: p.x * W, y: p.y * H }));
          const hc = pts.reduce((a, p) => ({ x: a.x + p.x / 21, y: a.y + p.y / 21 }), { x: 0, y: 0 });
          const hl = hull(pts).map(p => lerpPt(hc, p, 1.28));
          r.save(); path(r, hl); r.clip(); r.drawImage(video, 0, 0, W, H); r.restore();
        }
        this._edge(q, ch, e);
      }
    }

    // --- final: mirror (selfie view) + crop to format
    const o = this.octx, ow = this.out.width, sx = (W - ow) / 2;
    o.save(); o.translate(ow, 0); o.scale(-1, 1);
    o.drawImage(this.raw, sx, 0, ow, H, 0, 0, ow, H);
    o.restore();
  }

  _edge(q, ch, alpha) {
    const r = this.r;
    r.save(); r.globalAlpha = alpha; r.lineJoin = "round";
    r.shadowBlur = 24; r.shadowColor = ch.glow; r.strokeStyle = ch.glow; r.lineWidth = 6;
    r.translate(3, 0); path(r, q); r.stroke();
    r.translate(-6, 0); r.strokeStyle = ch.accent; r.shadowColor = ch.accent; path(r, q); r.stroke();
    r.translate(3, 0); r.shadowBlur = 0; r.strokeStyle = "#fff"; r.lineWidth = 2; path(r, q); r.stroke();
    r.restore();
  }

  _edgeLine(pts, ch) {
    const r = this.r;
    r.save(); r.shadowBlur = 30; r.shadowColor = ch.glow; r.strokeStyle = "#fff"; r.lineWidth = 4;
    r.beginPath(); r.moveTo(pts[0].x, pts[0].y); r.lineTo(pts[1].x, pts[1].y); r.stroke(); r.restore();
  }
}
