// Procedural costumes, drawn every frame from the tracked body + face.
// Pipeline (see compositor): paint() -> fabric shading from the live video -> overlay() -> clipped to the person mask.

// ---------- geometry helpers ----------
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const len = a => Math.hypot(a.x, a.y) || 1;
const norm = a => mul(a, 1 / len(a));
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a, b) => len(sub(a, b));

const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

// Build a "rig" (pixel-space body + head measurements) from tracker landmarks.
export function makeRig(tracker, W, H) {
  const px = p => ({ x: p.x * W, y: p.y * H });
  const rig = { W, H, body: null, head: null };

  const P = tracker.pose;
  if (P) {
    const SL = px(P[11]), SR = px(P[12]), HL = px(P[23]), HR = px(P[24]);
    const C = lerp(SL, SR, 0.5), HC = lerp(HL, HR, 0.5);
    const sw = dist(SL, SR);
    if (sw > 20) {
      const down = norm(sub(HC, C));
      const tl = Math.max(dist(C, HC), sw * 0.9);
      rig.body = {
        SL, SR, HL, HR, C, HC, sw, tl, down,
        EL: px(P[13]), ER: px(P[14]), WL: px(P[15]), WR: px(P[16]),
        chest: add(C, mul(down, tl * 0.28)),
        angle: Math.atan2(SR.y - SL.y, SR.x - SL.x),
      };
    }
  }

  const F = tracker.face;
  if (F) {
    const f = i => px(F[i]);
    const eyeA = lerp(f(33), f(133), 0.5), eyeB = lerp(f(362), f(263), 0.5);
    const fw = dist(f(234), f(454));
    rig.head = {
      f, fw, eyeA, eyeB,
      nose: f(1), chin: f(152), top: f(10), mouth: lerp(f(13), f(14), 0.5),
      center: lerp(f(10), f(152), 0.5),
      roll: Math.atan2(eyeB.y - eyeA.y, eyeB.x - eyeA.x),
      oval: FACE_OVAL.map(f),
    };
  }
  return rig;
}

// ---------- drawing helpers ----------
function poly(g, pts) { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) g.lineTo(p.x, p.y); g.closePath(); }

function limb(g, pts, width) {
  g.lineWidth = width; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (const p of pts.slice(1)) g.lineTo(p.x, p.y); g.stroke();
}

function scaledOval(oval, center, k) { return oval.map(p => add(center, mul(sub(p, center), k))); }

// spider-web: radial spokes + sagging rings
function web(g, c, radius, spokes, rings, color, lw, rot = 0) {
  g.save(); g.strokeStyle = color; g.lineWidth = lw; g.lineCap = "round";
  const ang = i => rot + (i / spokes) * Math.PI * 2;
  g.beginPath();
  for (let i = 0; i < spokes; i++) { g.moveTo(c.x, c.y); g.lineTo(c.x + Math.cos(ang(i)) * radius, c.y + Math.sin(ang(i)) * radius); }
  for (let k = 1; k <= rings; k++) {
    const r = (k / rings) * radius;
    for (let i = 0; i < spokes; i++) {
      const a0 = ang(i), a1 = ang(i + 1), am = (a0 + a1) / 2;
      const p0 = { x: c.x + Math.cos(a0) * r, y: c.y + Math.sin(a0) * r };
      const p1 = { x: c.x + Math.cos(a1) * r, y: c.y + Math.sin(a1) * r };
      const cp = { x: c.x + Math.cos(am) * r * 0.86, y: c.y + Math.sin(am) * r * 0.86 };
      g.moveTo(p0.x, p0.y); g.quadraticCurveTo(cp.x, cp.y, p1.x, p1.y);
    }
  }
  g.stroke(); g.restore();
}

// big mask lenses; `side` = -1 for the eye on the image-left, +1 for image-right
function lens(g, center, w, h, roll, side, fill, stroke, lw, inner) {
  g.save(); g.translate(center.x, center.y); g.rotate(roll + side * -0.38);
  g.beginPath();
  const o = side * w / 2;   // outer tip
  g.moveTo(o, -h * 0.45);
  g.quadraticCurveTo(-o * 0.2, -h * 0.75, -o, -h * 0.05);
  g.quadraticCurveTo(-o * 0.6, h * 0.65, o * 0.35, h * 0.45);
  g.quadraticCurveTo(o * 0.95, h * 0.2, o, -h * 0.45);
  g.closePath();
  g.fillStyle = fill; g.fill();
  if (stroke) { g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = "round"; g.stroke(); }
  if (inner) { g.lineWidth = lw * 0.25; g.strokeStyle = inner; g.stroke(); }
  g.restore();
}

function eyes(g, head, scale, fill, stroke, lwk, inner) {
  const w = head.fw * 0.40 * scale, h = head.fw * 0.27 * scale;
  const up = { x: Math.sin(head.roll) * head.fw * 0.03, y: -Math.cos(head.roll) * head.fw * 0.03 };
  const [a, b] = head.eyeA.x < head.eyeB.x ? [head.eyeA, head.eyeB] : [head.eyeB, head.eyeA];
  lens(g, add(a, up), w, h, head.roll, -1, fill, stroke, head.fw * lwk, inner);
  lens(g, add(b, up), w, h, head.roll, +1, fill, stroke, head.fw * lwk, inner);
}

function spider(g, c, size, angle, color) {
  g.save(); g.translate(c.x, c.y); g.rotate(angle); g.fillStyle = color; g.strokeStyle = color;
  g.beginPath(); g.ellipse(0, size * 0.25, size * 0.16, size * 0.32, 0, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.ellipse(0, -size * 0.18, size * 0.12, size * 0.14, 0, 0, Math.PI * 2); g.fill();
  g.lineWidth = size * 0.055; g.lineCap = "round"; g.lineJoin = "round";
  const legs = [[-0.1, -0.5, -0.55, -0.85], [-0.05, -0.75, -0.25, -0.95], [0.1, -0.75, 0.15, -0.6], [0.2, -0.6, 0.6, -0.2]];
  for (const s of [-1, 1]) for (const [y0, kx, ky, ey] of legs) {
    g.beginPath(); g.moveTo(0, y0 * size);
    g.lineTo(s * size * Math.abs(kx), size * ky);
    g.lineTo(s * size * Math.abs(kx) * 1.2, size * ey + size * ky * 0.1);
    g.stroke();
  }
  g.restore();
}

// ---------- characters ----------
export const CHARACTERS = {
  spiderman: {
    name: "Spider-Man", scene: "nyc", accent: "#e23636", glow: "#3d7bff", shade: 0.8,
    paint(g, r) {
      const { W, H, body: b, head: hd } = r;
      g.fillStyle = "#c4142b"; g.fillRect(0, 0, W, H);
      if (b) {
        web(g, b.chest, b.sw * 2.2, 22, 10, "rgba(12,8,14,.9)", Math.max(1.3, b.sw * 0.007), b.angle);
        const blue = "#1c3f9e";
        g.fillStyle = blue;
        for (const [S, Hp, other] of [[b.SL, b.HL, b.SR], [b.SR, b.HR, b.SL]]) {
          const out = norm(sub(S, other));
          const top = add(S, mul(b.down, b.tl * 0.32));
          poly(g, [add(top, mul(out, -b.sw * 0.07)), add(Hp, mul(out, -b.sw * 0.12)),
                   add(add(Hp, mul(out, b.sw)), mul(b.down, b.tl)), add(top, mul(out, b.sw * 1.2))]);
          g.fill();
        }
        // legs below the belt
        poly(g, [add(b.HL, mul(norm(sub(b.HL, b.HR)), b.sw)), add(b.HR, mul(norm(sub(b.HR, b.HL)), b.sw)),
                 add(b.HR, mul(b.down, H)), add(b.HL, mul(b.down, H))]); g.fill();
        // arms: blue sleeves with a red top stripe and red gloves
        for (const arm of [[b.SL, b.EL, b.WL], [b.SR, b.ER, b.WR]]) {
          g.strokeStyle = blue; limb(g, arm, b.sw * 0.34);
          g.strokeStyle = "#c4142b"; limb(g, arm, b.sw * 0.15);
          g.fillStyle = "#c4142b"; g.beginPath(); g.arc(arm[2].x, arm[2].y, b.sw * 0.17, 0, Math.PI * 2); g.fill();
        }
      }
      if (hd) {
        g.save(); g.beginPath(); g.ellipse(hd.center.x, hd.center.y, hd.fw * 0.75, hd.fw * 0.95, hd.roll, 0, Math.PI * 2); g.clip();
        g.fillStyle = "#c4142b"; g.fill();
        web(g, hd.nose, hd.fw * 1.3, 16, 7, "rgba(12,8,14,.9)", Math.max(1.2, hd.fw * 0.012), hd.roll - Math.PI / 2);
        g.restore();
      }
    },
    overlay(g, r) {
      if (r.body) spider(g, r.body.chest, r.body.sw * 0.42, r.body.angle, "#0b0b0f");
      if (r.head) eyes(g, r.head, 1, "#f7f9fc", "#0b0b0f", 0.055);
    },
  },

  spiderwoman: {
    name: "Spider-Woman", scene: "nyc", accent: "#ff4fa3", glow: "#9b5cff", shade: 0.7,
    paint(g, r) {
      const { W, H, body: b, head: hd } = r;
      g.fillStyle = "#efeff4"; g.fillRect(0, 0, W, H);
      if (b) {
        // pink web bands down the arms
        for (const arm of [[b.SL, b.EL, b.WL], [b.SR, b.ER, b.WR]]) {
          g.strokeStyle = "#d63384"; limb(g, arm, b.sw * 0.24);
          g.strokeStyle = "#efeff4"; limb(g, arm, b.sw * 0.13);
          // web hatching inside the pink band
          g.strokeStyle = "rgba(90,10,60,.8)"; g.lineWidth = Math.max(1, b.sw * 0.007);
          for (let s = 0; s < 2; s++) {
            const a = arm[s], c = arm[s + 1], n = Math.max(3, Math.round(dist(a, c) / (b.sw * 0.08)));
            const nrm = norm({ x: -(c.y - a.y), y: c.x - a.x });
            g.beginPath();
            for (let i = 0; i <= n; i++) {
              const p = lerp(a, c, i / n);
              for (const side of [-1, 1]) {
                const q = add(p, mul(nrm, side * b.sw * 0.09));
                g.moveTo(q.x, q.y); g.lineTo(q.x + nrm.x * side * b.sw * 0.04, q.y + nrm.y * side * b.sw * 0.04);
              }
            }
            g.stroke();
          }
        }
        // black torso (tapered to the waist) with the white neckline V
        const chestY = d => add(lerp(b.SL, b.SR, d), mul(b.down, b.tl * 0.18));
        g.fillStyle = "#141419";
        poly(g, [chestY(0.04), chestY(0.96), lerp(b.HL, b.HR, 0.9), add(lerp(b.HL, b.HR, 0.9), mul(b.down, H)),
                 add(lerp(b.HL, b.HR, 0.1), mul(b.down, H)), lerp(b.HL, b.HR, 0.1)]); g.fill();
        g.fillStyle = "#efeff4";
        poly(g, [add(lerp(b.SL, b.SR, 0.32), mul(b.down, b.tl * 0.05)), add(lerp(b.SL, b.SR, 0.68), mul(b.down, b.tl * 0.05)),
                 add(b.C, mul(b.down, b.tl * 0.42))]); g.fill();
      }
      if (hd) {
        // hood: white shell, purple-pink lining hugging the face
        g.save();
        g.strokeStyle = "#7b2c8f"; g.lineWidth = hd.fw * 0.2; g.lineJoin = "round";
        poly(g, scaledOval(hd.oval, hd.center, 1.12)); g.stroke();
        g.strokeStyle = "#ff4fa3"; g.lineWidth = hd.fw * 0.035;
        poly(g, scaledOval(hd.oval, hd.center, 1.02)); g.stroke();
        g.fillStyle = "#f4f4f8"; poly(g, scaledOval(hd.oval, hd.center, 0.99)); g.fill();
        g.restore();
      }
    },
    overlay(g, r) {
      if (r.head) eyes(g, r.head, 1.12, "#fbf7ff", "#ff3d9a", 0.06, "#2a0f2f");
    },
  },

  hulk: {
    name: "Hulk", scene: "nyc", accent: "#5adf5a", glow: "#2dff6e", shade: 0.75,
    paint(g, r) {
      const { W, H, body: b, head: hd } = r;
      g.fillStyle = "#1a4d1a"; g.fillRect(0, 0, W, H);
      if (b) {
        // purple torn trousers
        g.fillStyle = "#6b3fa0";
        poly(g, [add(b.HL, mul(norm(sub(b.HL, b.HR)), b.sw * 0.9)),
                 add(b.HR, mul(norm(sub(b.HR, b.HL)), b.sw * 0.9)),
                 add(b.HR, mul(b.down, H)), add(b.HL, mul(b.down, H))]); g.fill();
        // ragged tear lines on the trousers
        g.strokeStyle = "#3d1f6b"; g.lineWidth = Math.max(1.5, b.sw * 0.01);
        for (let i = 0; i < 4; i++) {
          const y = add(b.HL, mul(b.down, b.tl * (0.15 + i * 0.12)));
          g.beginPath(); g.moveTo(y.x - b.sw * 0.3, y.y); g.lineTo(y.x + b.sw * (0.1 + i * 0.05), y.y + b.tl * 0.04); g.stroke();
        }
        // green muscular arms — thick strokes
        for (const arm of [[b.SL, b.EL, b.WL], [b.SR, b.ER, b.WR]]) {
          g.strokeStyle = "#2d7a2d"; limb(g, arm, b.sw * 0.42);
          g.strokeStyle = "#3daa3d"; limb(g, arm, b.sw * 0.3);
        }
      }
      if (hd) {
        g.save();
        g.fillStyle = "#2d7a2d"; poly(g, scaledOval(hd.oval, hd.center, 1.18)); g.fill();
        g.fillStyle = "#3daa3d"; poly(g, scaledOval(hd.oval, hd.center, 1.0)); g.fill();
        g.restore();
      }
    },
    overlay(g, r) {
      if (!r.head) return;
      const hd = r.head;
      // angry brow ridge — dark heavy line above the eyes
      g.save();
      g.strokeStyle = "#1a3d1a"; g.lineWidth = hd.fw * 0.07; g.lineCap = "round";
      const up = { x: Math.sin(hd.roll) * hd.fw * 0.14, y: -Math.cos(hd.roll) * hd.fw * 0.14 };
      g.beginPath();
      g.moveTo(hd.eyeA.x - hd.fw * 0.18 + up.x, hd.eyeA.y - hd.fw * 0.04 + up.y);
      g.lineTo(hd.eyeA.x + hd.fw * 0.18 + up.x * 0.5, hd.eyeA.y + hd.fw * 0.04 + up.y * 0.5);
      g.moveTo(hd.eyeB.x - hd.fw * 0.18 + up.x * 0.5, hd.eyeB.y + hd.fw * 0.04 + up.y * 0.5);
      g.lineTo(hd.eyeB.x + hd.fw * 0.18 + up.x, hd.eyeB.y - hd.fw * 0.04 + up.y);
      g.stroke();
      // white eyes
      eyes(g, hd, 0.85, "#ffffff", "#1a3d1a", 0.045);
      g.restore();
    },
  },

  ironman: {
    name: "Iron Man", scene: "corridor", accent: "#ffc23d", glow: "#ff3b3b", shade: 0.62, metal: true,
    paint(g, r) {
      const { W, H, body: b, head: hd } = r;
      g.fillStyle = "#a10f1c"; g.fillRect(0, 0, W, H);
      if (b) {
        // gold forearms, dark armour seams on the torso
        for (const arm of [[b.EL, b.WL], [b.ER, b.WR]]) { g.strokeStyle = "#d8a321"; limb(g, arm, b.sw * 0.3); }
        g.strokeStyle = "rgba(60,5,10,.85)"; g.lineWidth = Math.max(1.5, b.sw * 0.012);
        g.beginPath();
        g.moveTo(b.chest.x, b.chest.y); g.lineTo(b.HC.x, b.HC.y);
        for (const s of [0.2, 0.8]) { const p = lerp(b.SL, b.SR, s); g.moveTo(p.x, p.y); g.quadraticCurveTo(b.chest.x, b.chest.y + b.tl * 0.25, b.HC.x, b.HC.y); }
        for (let k = 1; k <= 3; k++) { const y = add(b.chest, mul(b.down, b.tl * (0.2 + k * 0.13))); g.moveTo(y.x - b.sw * 0.25, y.y); g.lineTo(y.x + b.sw * 0.25, y.y); }
        g.stroke();
      }
      if (hd) {
        g.save();
        g.fillStyle = "#a10f1c"; poly(g, scaledOval(hd.oval, hd.center, 1.15)); g.fill();
        // gold faceplate
        const plate = scaledOval(hd.oval, add(hd.center, mul({ x: 0, y: 1 }, hd.fw * 0.05)), 0.9);
        g.fillStyle = "#d8a321"; poly(g, plate); g.fill();
        g.strokeStyle = "rgba(70,40,0,.8)"; g.lineWidth = Math.max(1.2, hd.fw * 0.018);
        g.beginPath();
        g.moveTo(hd.mouth.x - hd.fw * 0.16, hd.mouth.y); g.lineTo(hd.mouth.x + hd.fw * 0.16, hd.mouth.y);
        for (const e of [hd.eyeA, hd.eyeB]) { g.moveTo(e.x, e.y + hd.fw * 0.1); g.quadraticCurveTo(e.x, hd.chin.y - hd.fw * 0.1, hd.chin.x, hd.chin.y); }
        g.stroke();
        g.restore();
      }
    },
    overlay(g, r) {
      g.save();
      if (r.body) {
        const c = r.body.chest, rad = r.body.sw * 0.12;
        const gr = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, rad * 2.2);
        gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.3, "rgba(170,245,255,.95)"); gr.addColorStop(1, "rgba(120,220,255,0)");
        g.fillStyle = gr; g.beginPath(); g.arc(c.x, c.y, rad * 2.2, 0, Math.PI * 2); g.fill();
        g.strokeStyle = "#d9e2e6"; g.lineWidth = rad * 0.25; g.beginPath(); g.arc(c.x, c.y, rad, 0, Math.PI * 2); g.stroke();
      }
      if (r.head) {
        const hd = r.head;
        g.shadowColor = "#bff6ff"; g.shadowBlur = hd.fw * 0.2; g.fillStyle = "#f2feff";
        const [a, b] = hd.eyeA.x < hd.eyeB.x ? [hd.eyeA, hd.eyeB] : [hd.eyeB, hd.eyeA];
        for (const [e, s] of [[a, -1], [b, 1]]) {
          g.save(); g.translate(e.x, e.y); g.rotate(hd.roll + s * -0.12);
          const w = hd.fw * 0.3, h = hd.fw * 0.065;
          poly(g, [{ x: -w / 2, y: -h / 2 + (s < 0 ? h * 0.6 : 0) }, { x: w / 2, y: -h / 2 + (s > 0 ? h * 0.6 : 0) },
                   { x: w / 2 - h * 0.4, y: h / 2 }, { x: -w / 2 + h * 0.4, y: h / 2 }]);
          g.fill(); g.restore();
        }
      }
      g.restore();
    },
  },
};
