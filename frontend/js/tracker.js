// Motion capture: hands, body pose, face mesh and a person/hair/face segmentation mask.
// All landmarks are kept in normalised, UN-mirrored video coordinates.
import { FilesetResolver, HandLandmarker, PoseLandmarker, FaceLandmarker, ImageSegmenter }
  from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";

const V = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const G = "https://storage.googleapis.com/mediapipe-models";
const MODELS = {
  hand: `${G}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
  pose: `${G}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  face: `${G}/face_landmarker/face_landmarker/float16/1/face_landmarker.task`,
  seg:  `${G}/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite`,
};

const smooth = v => { const k = Math.min(1, Math.max(0, (v - 0.25) / 0.5)); return k * k * (3 - 2 * k); };

function maskCanvas() {
  const c = document.createElement("canvas");
  return { c, g: c.getContext("2d", { willReadFrequently: false }) };
}

export class Tracker {
  constructor() {
    this.hands = [];         // array of 21-point hands
    this.pose = null;        // 33 points
    this.face = null;        // 478 points
    this.person = maskCanvas(); // alpha = person
    this.maskReady = false;
    this.frame = 0;
  }

  async load(progress = () => {}) {
    const fs = await FilesetResolver.forVisionTasks(V);
    const build = async delegate => {
      const base = p => ({ modelAssetPath: p, delegate });
      progress("hands");
      this.handLm = await HandLandmarker.createFromOptions(fs, { baseOptions: base(MODELS.hand), runningMode: "VIDEO", numHands: 2 });
      progress("body");
      this.poseLm = await PoseLandmarker.createFromOptions(fs, { baseOptions: base(MODELS.pose), runningMode: "VIDEO", numPoses: 1 });
      progress("face");
      this.faceLm = await FaceLandmarker.createFromOptions(fs, { baseOptions: base(MODELS.face), runningMode: "VIDEO", numFaces: 1 });
      progress("segmentation");
      this.seg = await ImageSegmenter.createFromOptions(fs, { baseOptions: base(MODELS.seg), runningMode: "VIDEO",
        outputConfidenceMasks: true, outputCategoryMask: false });
    };
    try { await build("GPU"); this.delegate = "GPU"; }
    catch (e) { console.warn("GPU delegate failed, falling back to CPU", e); await build("CPU"); this.delegate = "CPU"; }
    this.fs = fs;
  }

  // Still-image (IMAGE mode) detectors for hero references. VIDEO-mode detectors carry tracking
  // state between calls, which gets confused when fed unrelated still images back to back.
  async _imageTasks() {
    if (this._imgTasks) return this._imgTasks;
    const base = p => ({ modelAssetPath: p, delegate: this.delegate });
    this._imgTasks = {
      pose: await PoseLandmarker.createFromOptions(this.fs, { baseOptions: base(MODELS.pose), runningMode: "IMAGE", numPoses: 1 }),
      face: await FaceLandmarker.createFromOptions(this.fs, { baseOptions: base(MODELS.face), runningMode: "IMAGE", numFaces: 1 }),
      hand: await HandLandmarker.createFromOptions(this.fs, { baseOptions: base(MODELS.hand), runningMode: "IMAGE", numHands: 2 }),
    };
    return this._imgTasks;
  }

  releaseImageTasks() {
    if (!this._imgTasks) return;
    Object.values(this._imgTasks).forEach(t => t.close());
    this._imgTasks = null;
  }

  // MediaPipe VIDEO mode needs strictly increasing timestamps across every call
  _ts(now) { this.lastTs = Math.max((this.lastTs || 0) + 1, Math.floor(now)); return this.lastTs; }

  // One-off analysis of a still image (hero reference). Returns landmarks + a person-mask canvas.
  async analyzeImage(img) {
    const t = () => this._ts(performance.now());
    const it = await this._imageTasks();
    let pose = it.pose.detect(img).landmarks?.[0] || null;
    // statues / unusual bodies: the video-mode detector sometimes locks on where the still one doesn't
    for (let k = 0; k < 3 && !pose; k++) pose = this.poseLm.detectForVideo(img, t()).landmarks?.[0] || null;
    const face = it.face.detect(img).faceLandmarks?.[0] || null;
    const hands = it.hand.detect(img).landmarks || [];
    let mask = null;
    this.seg.segmentForVideo(img, t(), r => {
      const bg = r.confidenceMasks[0], w = bg.width, h = bg.height, a = bg.getAsFloat32Array();
      mask = document.createElement("canvas"); mask.width = w; mask.height = h;
      const g = mask.getContext("2d"), im = g.createImageData(w, h);
      for (let i = 0; i < a.length; i++) { im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = 255; im.data[i * 4 + 3] = smooth(1 - a[i]) * 255; }
      g.putImageData(im, 0, 0);
      r.confidenceMasks.forEach(m => m.close());
    });
    return { pose, face, hands, mask };
  }

  // Run once per new camera frame. Only ONE landmark model runs per frame so each frame stays short
  // (running all of them back to back froze phones): hands every other frame, body and face take turns
  // in between. The 3D heroes interpolate between updates, so motion still looks smooth.
  // The person mask is only needed for the drawn-suit fallback, so it's skipped for 3D / photo heroes.
  update(video, rafNow, { needMask = true } = {}) {
    const now = this._ts(rafNow);
    this.frame++;
    const f = this.frame % 4;
    try {
      if (f % 2 === 0) this.hands = this.handLm.detectForVideo(video, now).landmarks || [];
      else if (f === 1) {
        const r = this.poseLm.detectForVideo(video, now);
        this.pose = r.landmarks?.[0] || null;
        this.poseWorld = r.worldLandmarks?.[0] || null;   // 3D, metres, hip-centred — drives 3D heroes
      } else this.face = this.faceLm.detectForVideo(video, now).faceLandmarks?.[0] || null;
    } catch (e) { console.warn("tracking", e); }

    if (needMask && f % 2 === 1) {
      try { this.seg.segmentForVideo(video, now, r => this._readMask(r)); }
      catch (e) { console.warn("segment", e); }
    }
  }

  _readMask(r) {
    // multiclass confidence masks: 0 background, 1 hair, 2 body-skin, 3 face-skin, 4 clothes, 5 other
    const bg = r.confidenceMasks[0];
    const w = bg.width, h = bg.height, a = bg.getAsFloat32Array();
    const { c, g } = this.person;
    if (c.width !== w) { c.width = w; c.height = h; this._img = g.createImageData(w, h); this._img.data.fill(255); }
    const d = this._img.data;
    for (let i = 0; i < a.length; i++) d[i * 4 + 3] = smooth(1 - a[i]) * 255;
    g.putImageData(this._img, 0, 0);
    this.maskReady = true;
    r.confidenceMasks.forEach(m => m.close());
  }
}
