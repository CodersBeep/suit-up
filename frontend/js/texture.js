// Real hero images: a clean cut-out of the hero photo that follows your head —
// it moves and scales with you (stays upright) (no stretching / mesh warping, so it always looks like the photo).

const P = (a, W, H) => ({ x: a.x * W, y: a.y * H });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const len = a => Math.hypot(a.x, a.y) || 1;

// How much bigger the hero's head is drawn than yours, so the hero fully covers you.
const COVER = 1.15;
// How much of your head tilt the hero copies (0 = stays upright, 1 = tilts fully with you).
const TILT = 0;

// ---------- reference preparation: cut the hero out of its photo ----------
function cleanReference(img, info) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  // keep only the hero (drop the room behind them)
  g.globalCompositeOperation = "destination-in"; g.filter = "blur(2px)";
  g.drawImage(info.mask, 0, 0, W, H);
  g.globalCompositeOperation = "source-over"; g.filter = "none";
  // Helmets / statues: the person-segmenter often drops a metal face as "background".
  // With "keepHead": true in <hero>.json, always keep an ellipse around the head.
  if (info.keepHead && info.pose) {
    const L = P(info.pose[8], W, H), R = P(info.pose[7], W, H);
    const w = len(sub(R, L)), cx = (L.x + R.x) / 2, cy = (L.y + R.y) / 2 - w * 0.07;
    const SL = P(info.pose[12], W, H), SR = P(info.pose[11], W, H);   // image-left / image-right shoulder
    const neckY = cy + w * 0.6;
    // head
    g.save(); g.beginPath(); g.ellipse(cx, cy, w * 0.55, w * 0.72, 0, 0, Math.PI * 2);
    g.clip(); g.drawImage(img, 0, 0); g.restore();
    // neck + torso between the shoulders
    g.save(); g.beginPath();
    g.moveTo(cx - w * 0.3, neckY); g.lineTo(cx + w * 0.3, neckY);
    g.lineTo(SR.x, SR.y); g.lineTo(SR.x, H); g.lineTo(SL.x, H); g.lineTo(SL.x, SL.y); g.closePath();
    g.clip(); g.drawImage(img, 0, 0); g.restore();
  }
  // The hero is placed whole, so its own hands/pose are part of the look — keep them.
  return c;
}

// ---------- head anchor: left-edge point, right-edge point (image left -> image right) ----------
function headFromPose(pose, W, H) {
  return { L: P(pose[8], W, H), R: P(pose[7], W, H) };     // ears
}
function headFromFace(face, W, H) {
  return { L: P(face[234], W, H), R: P(face[454], W, H) }; // cheek edges ≈ ear line
}
function measure({ L, R }) {
  const v = sub(R, L);
  return { c: lerp(L, R, 0.5), w: len(v), a: Math.atan2(v.y, v.x) };
}

// ---------- public API ----------
export class HeroTexture {
  static async load(url, tracker) {
    const img = new Image();
    const ok = await new Promise(r => { img.onload = () => r(true); img.onerror = () => r(false); img.src = url; });
    if (!ok) return null;                                    // no reference image -> drawn suit is used
    const info = await tracker.analyzeImage(img);
    // optional hand-placed keypoints (<hero>.json) for references the detector can't read (statues, helmets)
    try {
      const r = await fetch(url.replace(/\.\w+$/, ".json"));
      const manual = r.ok ? await r.json() : null;
      if (manual?.pose) {
        const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
        for (const [k, [x, y]] of Object.entries(manual.pose)) pose[+k] = { x, y, z: 0 };
        Object.assign(info, { pose, face: null, hands: [], keepHead: !!manual.keepHead });
      }
    } catch { /* no override file */ }
    if (!info.pose || !info.mask) { console.warn("hero reference: no body found in", url); return null; }
    return new HeroTexture(img, info);
  }

  constructor(img, info) {
    this.tex = cleanReference(img, info);
    const W = img.naturalWidth, H = img.naturalHeight;
    this.ref = measure(headFromPose(info.pose, W, H));
    // ear points are unreliable on masks/toys (often far too close) — a head is ~1/2.6 of shoulder width
    const shoulders = len(sub(P(info.pose[11], W, H), P(info.pose[12], W, H)));
    this.ref.w = Math.max(this.ref.w, shoulders / 2.6);
    this.out = document.createElement("canvas");
    this.state = null;   // smoothed live head
  }

  // canvas (W×H) with the hero placed over you, or null if you're not tracked
  render(tracker, W, H) {
    const head = tracker.face ? headFromFace(tracker.face, W, H) : tracker.pose ? headFromPose(tracker.pose, W, H) : null;
    if (!head) return this.state ? this._draw(W, H) : null;
    const m = measure(head);
    if (m.w < 8) return this.state ? this._draw(W, H) : null;
    // smooth so it glides with you instead of jittering
    const s = this.state, k = 0.45;
    this.state = s ? { c: lerp(s.c, m.c, k), w: s.w + (m.w - s.w) * k, a: s.a + (m.a - s.a) * k } : m;
    return this._draw(W, H);
  }

  _draw(W, H) {
    const o = this.out;
    if (o.width !== W || o.height !== H) { o.width = W; o.height = H; }
    const g = o.getContext("2d"), r = this.ref, s = this.state;
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, H);
    g.translate(s.c.x, s.c.y);
    g.rotate((s.a - r.a) * TILT);
    const k = (s.w * COVER) / r.w;
    g.scale(k, k);
    g.translate(-r.c.x, -r.c.y);
    g.drawImage(this.tex, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return o;
  }
}
