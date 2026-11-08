import { Tracker } from "./tracker.js";
import { Compositor } from "./compositor.js";
import { CHARACTERS } from "./costumes.js";
import { palmOpen } from "./gestures.js";
import { health, uploadClip } from "./api.js";
import { HeroTexture } from "./texture.js";
import { Avatar3D } from "./avatar3d.js";

// rigged 3D models (Mixamo skeleton). Heroes without one fall back to their photo.
const MODELS = {
  spiderman: { model: "assets/models/spiderman/spiderman.fbx", texture: "assets/models/spiderman/spiderman.jpg" },
  // 3ds Max Biped skeleton (bone names translated in avatar3d.js)
  spiderwoman: { model: "assets/models/spiderwoman/spiderwoman.fbx", texture: "assets/models/spiderwoman/SpiderGwen_tex.png" },
  // rigid armour pieces with no skeleton -> auto-rigged in the browser, painted red/gold metal
  ironman: { model: "assets/models/ironman/ironman.fbx", autoRig: true, style: "ironman" },
};

const $ = id => document.getElementById(id);
const msg = t => ($("msg").textContent = t);
const cam = $("cam");

const tracker = new Tracker();
const comp = new Compositor($("out"));
const opts = { character: "spiderman", mode: "window", world: "auto", format: "9:16" };
let ready = false, running = false;
window.suit = { tracker, comp, opts };   // debug handle

function refresh() {
  $("start").disabled = !ready || running;
  $("rec").disabled = !running;
}

// ---------- controls ----------
function pickHero(id) {
  if (!CHARACTERS[id]) return;
  opts.character = id;
  document.querySelectorAll(".hero").forEach(b => b.classList.toggle("on", b.dataset.id === id));
}
document.querySelectorAll(".hero").forEach(b => (b.onclick = () => pickHero(b.dataset.id)));
$("mode").onchange = e => (opts.mode = e.target.value);
$("world").onchange = e => (opts.world = e.target.value);
$("format").onchange = e => { opts.format = e.target.value; if (running) comp.setFormat(opts.format); };
addEventListener("keydown", e => {
  if (/SELECT|INPUT/.test(document.activeElement?.tagName)) return;
  const ids = Object.keys(CHARACTERS);
  if (["Digit1", "Digit2", "Digit3"].includes(e.code)) pickHero(ids[+e.code.slice(-1) - 1]);
  if (e.code === "Space" && running) {
    e.preventDefault();
    opts.mode = opts.mode === "full" ? "window" : "full"; $("mode").value = opts.mode;
  }
});

// ---------- boot ----------
(async () => {
  // the free backend sleeps when idle; this ping also wakes it so saving a clip later is quick
  health().catch(() => console.warn("Backend not reachable yet (saving clips needs it)"));
  try {
    await tracker.load(step => msg(`Loading motion capture… (${step})`));
    // real heroes: any hero with a photo in assets/heroes/<id>.jpg uses it (else the drawn suit)
    msg("Preparing heroes…");
    for (const id of Object.keys(CHARACTERS)) {
      if (MODELS[id]) {
        try { msg(`Loading 3D ${CHARACTERS[id].name}…`); CHARACTERS[id].avatar = await Avatar3D.load(MODELS[id], tracker); }
        catch (e) { console.warn("3D model", id, e); }
      }
      if (!CHARACTERS[id].avatar) {
        try { CHARACTERS[id].tex = await HeroTexture.load(`assets/heroes/${id}.jpg`, tracker); }
        catch (e) { console.warn("hero image", id, e); }
      }
      const btn = document.querySelector(`.hero[data-id=${id}] small`);
      if (btn) btn.textContent = CHARACTERS[id].avatar ? "3D" : CHARACTERS[id].tex ? "real" : "drawn";
    }
    tracker.releaseImageTasks();   // free the still-image detectors once references are prepared
    ready = true; msg("Ready. Start the camera.");
  } catch (e) { console.error(e); msg("Model load failed: " + e.message); }
  refresh();
})();

// ---------- camera ----------
$("start").onclick = async () => {
  try {
    cam.srcObject = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" }, audio: false });
    await cam.play();
    comp.resize(cam.videoWidth, cam.videoHeight, opts.format);
    running = true; refresh();
    msg("Live — raise both open palms!");
    requestAnimationFrame(loop);
  } catch (e) { msg("Camera error: " + e.message + " (needs https or localhost)"); }
};

// ---------- main loop ----------
let lastVT = -1, prev = performance.now(), fpsAcc = 0, fpsN = 0;
function loop(now) {
  try {
    const dt = Math.min(100, now - prev); prev = now;
    if (cam.currentTime !== lastVT && cam.readyState >= 2) {
      lastVT = cam.currentTime;
      tracker.update(cam, now);
      const open = tracker.hands.filter(palmOpen).length;
      const parts = [tracker.pose ? "body" : null, tracker.face ? "face" : null, `${open}/2 palms`].filter(Boolean);
      $("cTrack").textContent = parts.join(" · ");
      $("cTrack").classList.toggle("on", open === 2);
    }
    comp.render(cam, tracker, opts, dt);

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 500) { $("cFps").textContent = Math.round(1000 * fpsN / fpsAcc) + " fps"; fpsAcc = 0; fpsN = 0; }
  } catch (e) { console.error("frame error", e); }
  requestAnimationFrame(loop);
}

// ---------- recording -> backend -> share link ----------
let rec = null, chunks = [];
$("rec").onclick = () => {
  if (rec && rec.state === "recording") { rec.stop(); return; }
  const mime = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm", "video/mp4"].find(m => MediaRecorder.isTypeSupported(m));
  rec = new MediaRecorder($("out").captureStream(30), { mimeType: mime, videoBitsPerSecond: 6e6 });
  chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    $("rec").textContent = "● Record";
    const blob = new Blob(chunks, { type: rec.mimeType });
    $("dl").href = URL.createObjectURL(blob);
    $("dl").download = "suit-up." + (rec.mimeType.includes("mp4") ? "mp4" : "webm");
    $("clip").hidden = false; $("clipLink").value = "Saving…";
    try { $("clipLink").value = (await uploadClip(blob)).share_url; }
    catch (e) { $("clipLink").value = "Save failed: " + e.message; }
  };
  rec.start(); $("rec").textContent = "■ Stop & save";
};
$("copy").onclick = () => navigator.clipboard?.writeText($("clipLink").value);
