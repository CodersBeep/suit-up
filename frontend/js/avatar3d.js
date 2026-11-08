// Live 3D hero: a rigged (Mixamo-skeleton) model whose bones follow your tracked body every frame.
//
//   MediaPipe pose (3D world points) ──> torso + upper arm + forearm + hand directions
//   MediaPipe face mesh             ──> head orientation
//   each bone is rotated so it points the same way as your matching body part,
//   then the whole model is scaled/positioned so its head sits on your head in the camera image.
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const COVER = 1.12;     // hero head drawn this much bigger than yours, so it covers you
const SMOOTH = 0.45;    // bone smoothing per frame (1 = no smoothing)

// MediaPipe pose indices
const L_SH = 11, R_SH = 12, L_EL = 13, R_EL = 14, L_WR = 15, R_WR = 16, L_PI = 17, R_PI = 18, L_IN = 19, R_IN = 20, L_HIP = 23, R_HIP = 24;

const name = n => n.replace(/^mixamorig:?/, "");
// 3ds Max "Biped" skeleton names (as sanitised by three.js) -> the Mixamo-style names used below
const BIPED = {
  Bip001_Spine: "Spine", Bip001_Neck: "Neck", Bip001_Head: "Head",
  Bip001_L_UpperArm: "LeftArm", Bip001_L_Forearm: "LeftForeArm", Bip001_L_Hand: "LeftHand", Bip001_L_Finger2: "LeftHandMiddle1",
  Bip001_R_UpperArm: "RightArm", Bip001_R_Forearm: "RightForeArm", Bip001_R_Hand: "RightHand", Bip001_R_Finger2: "RightHandMiddle1",
};
// MediaPipe world (x right, y down, z away-from-camera is +) -> three.js (x right, y up, z toward camera)
const world = p => new THREE.Vector3(p.x, -p.y, -p.z);
const vis = p => (p.visibility ?? 1) > 0.5;

// rotation taking the basis (rest lateral, rest up) onto (target lateral, target up)
function basisQuat(lat, up) {
  const x = lat.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// ---------- auto-rig for models made of rigid parts with no skeleton (e.g. armour) ----------
// Renders the model from the front, finds its joints with the same body tracker we use on you,
// builds a pivot "skeleton" at those joints and attaches every part to the nearest body segment.
// `saved` = joints found earlier (cfg.rig JSON): skips the render + detection, and keeps the rig identical.
export async function detectRigPose(obj, tracker) {
  const { c, viewW, viewH } = rigFrame(obj);
  const RW = 500, RH = 800;
  // front render on white
  const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setSize(RW, RH, false); r.setClearColor(0xffffff);
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.5));
  const d = new THREE.DirectionalLight(0xffffff, 2); d.position.set(0.3, 1, 1); sc.add(d);
  const parent = obj.parent; sc.add(obj);
  const cam = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, -1e4, 1e4);
  cam.position.set(c.x, c.y, c.z + 1000); cam.lookAt(c);
  r.render(sc, cam);
  const img = new Image(); img.src = r.domElement.toDataURL("image/png"); await img.decode();
  r.dispose(); sc.remove(obj); if (parent) parent.add(obj);
  const P = (await tracker.analyzeImage(img)).pose;
  if (!P) throw new Error("auto-rig: couldn't find a body in the model render");
  return P.map(p => ({ x: p.x, y: p.y }));
}

// the model's front-view frame that pose coordinates (0..1) are measured in
function rigFrame(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
  const viewH = size.y * 1.05, viewW = viewH * 500 / 800;
  return { c, viewW, viewH };
}

async function autoRig(obj, tracker, saved) {
  const { c, viewW, viewH } = rigFrame(obj);
  const P = saved || await detectRigPose(obj, tracker);
  const J = i => new THREE.Vector3(c.x + (P[i].x - 0.5) * viewW, c.y + (0.5 - P[i].y) * viewH, c.z);

  const shL = J(L_SH), shR = J(R_SH), elL = J(L_EL), elR = J(R_EL), wrL = J(L_WR), wrR = J(R_WR);
  const hipL = J(L_HIP), hipR = J(R_HIP), knL = J(25), knR = J(26), nose = J(0);
  const shMid = shL.clone().add(shR).multiplyScalar(0.5), hipMid = hipL.clone().add(hipR).multiplyScalar(0.5);
  const neck = shMid.clone().lerp(nose, 0.35);
  const headTop = nose.clone().add(nose.clone().sub(neck).multiplyScalar(0.9));
  const tipL = wrL.clone().add(wrL.clone().sub(elL).multiplyScalar(0.45)), tipR = wrR.clone().add(wrR.clone().sub(elR).multiplyScalar(0.45));

  // pivot skeleton (world positions), parented like a real rig
  const root = new THREE.Group(); obj.add(root);
  root.updateMatrixWorld(true);
  const pivot = (parentObj, pos, nm) => {
    const p = new THREE.Object3D(); p.name = nm;
    parentObj.add(p); parentObj.updateMatrixWorld(true);
    p.position.copy(parentObj.worldToLocal(pos.clone())); p.updateMatrixWorld(true);
    return p;
  };
  const b = {};
  b.Spine = pivot(root, hipMid, "Spine");
  b.Neck = pivot(b.Spine, neck, "Neck");
  b.Head = pivot(b.Neck, neck, "Head");
  b.HeadTop_End = pivot(b.Head, headTop, "HeadTop_End");
  for (const [S, sh, el, wr, tip] of [["Left", shL, elL, wrL, tipL], ["Right", shR, elR, wrR, tipR]]) {
    b[`${S}Arm`] = pivot(b.Spine, sh, `${S}Arm`);
    b[`${S}ForeArm`] = pivot(b[`${S}Arm`], el, `${S}ForeArm`);
    b[`${S}Hand`] = pivot(b[`${S}ForeArm`], wr, `${S}Hand`);
    b[`${S}HandMiddle1`] = pivot(b[`${S}Hand`], tip, `${S}HandMiddle1`);
  }

  // segments each part may belong to (legs stay on the static root)
  const segs = [
    ["Spine", hipMid, shMid], ["Head", neck, headTop],
    ["LeftArm", shL, elL], ["LeftForeArm", elL, wrL], ["LeftHand", wrL, tipL],
    ["RightArm", shR, elR], ["RightForeArm", elR, wrR], ["RightHand", wrR, tipR],
    ["legs", hipL, knL], ["legs", hipR, knR],
    ["legs", knL, knL.clone().add(knL.clone().sub(hipL))], ["legs", knR, knR.clone().add(knR.clone().sub(hipR))],
  ];
  const segDist = (p, a, q) => {   // distance in the front plane (x, y)
    const ax = q.x - a.x, ay = q.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * ax + (p.y - a.y) * ay) / (ax * ax + ay * ay || 1)));
    return Math.hypot(p.x - (a.x + ax * t), p.y - (a.y + ay * t));
  };
  const meshes = []; obj.traverse(o => { if (o.isMesh) meshes.push(o); });
  for (const m of meshes) {
    const ctr = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    let best = "legs", bd = Infinity;
    for (const [nm, a, q] of segs) { const dd = segDist(ctr, a, q); if (dd < bd) { bd = dd; best = nm; } }
    (best === "legs" ? root : b[best]).attach(m);
    m.userData.segment = best; m.userData.center = ctr;
  }
  return b;
}

// metal paint job for models that ship without textures (e.g. Iron Man), keyed by original colour
function ironManMaterials(obj, bones) {
  const red = new THREE.MeshStandardMaterial({ color: 0xa8101c, metalness: 0.75, roughness: 0.28 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd8a52a, metalness: 0.85, roughness: 0.25 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2c33, metalness: 0.8, roughness: 0.35 });
  const glow = new THREE.MeshStandardMaterial({ color: 0xcffbff, emissive: 0x9ff4ff, emissiveIntensity: 2.2 });
  const headZ = bones.Head.getWorldPosition(new THREE.Vector3()).z;
  obj.traverse(o => {
    if (!o.isMesh) return;
    const pick = m => {
      const hex = m.color ? m.color.getHexString() : "";
      if (hex === "5accbb") return glow;                                       // eyes + arc reactor
      if (hex === "380000") return red;                                        // main armour
      // the dark front-of-head plate is the faceplate -> gold
      if (o.userData.segment === "Head" && o.userData.center.z > headZ) return gold;
      return dark;
    };
    o.material = Array.isArray(o.material) ? o.material.map(pick) : pick(o.material);
    o.frustumCulled = false;
  });
}

export class Avatar3D {
  // cfg: { model, texture?, autoRig?, style? }
  static async load(cfg, tracker) {
    // .glb = compressed (meshopt) models, a fraction of the size of the original FBX; .fbx still supported
    const obj = cfg.model.endsWith(".glb")
      ? (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(cfg.model)).scene
      : await new FBXLoader().loadAsync(cfg.model);
    let bones = null;
    if (cfg.autoRig) {
      const saved = cfg.rig ? await fetch(cfg.rig).then(r => r.ok ? r.json() : null).catch(() => null) : null;
      bones = await autoRig(obj, tracker, saved);
    }
    if (cfg.texture) {
      const tex = await new THREE.TextureLoader().loadAsync(cfg.texture);
      tex.colorSpace = THREE.SRGBColorSpace;
      // some exporters write UVs outside 0..1 (this Spider-Man uses v in -1..0) — wrap instead of clamping
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 4;
      obj.traverse(o => {
        if (!o.isMesh) return;
        const make = () => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.05 });
        o.material = Array.isArray(o.material) ? o.material.map(make) : make();
        o.frustumCulled = false;
      });
    }
    if (cfg.style === "ironman") ironManMaterials(obj, bones);
    return new Avatar3D(obj, bones);
  }

  constructor(obj, bones = null) {
    this.canvas = document.createElement("canvas");
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);

    this.scene = new THREE.Scene();
    // soft studio reflections so metal (Iron Man) reads as metal
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(0.4, 1, 1.2); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x88aaff, 1.0); rim.position.set(-1, 0.5, -1); this.scene.add(rim);

    this.group = new THREE.Group();
    this.group.add(obj);
    this.scene.add(this.group);
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -1e5, 1e5);   // set to pixel units in render()

    // bones by short name (Hips, Spine, LeftArm, ...)
    this.b = bones || {};
    // (glTF loads unskinned end markers like HeadTop_End as plain nodes, not bones — include those too)
    if (!bones) obj.traverse(o => { if (o.isBone || /_End$/.test(o.name)) this.b[BIPED[o.name] || name(o.name)] = o; });
    // rigs without a head-top bone (e.g. 3ds Max Biped): add one above the head
    if (!this.b.HeadTop_End && this.b.Head && this.b.Neck && this.b.LeftArm && this.b.RightArm) {
      obj.updateMatrixWorld(true);
      const p = n => this.b[n].getWorldPosition(new THREE.Vector3());
      const up = p("Head").sub(p("Neck")).normalize();
      const top = p("Head").add(up.multiplyScalar(p("LeftArm").distanceTo(p("RightArm")) * 0.75));
      const t = new THREE.Object3D(); t.name = "HeadTop_End";
      this.b.Head.add(t); t.position.copy(this.b.Head.worldToLocal(top));
      this.b.HeadTop_End = t;
    }
    const need = ["Spine", "Neck", "Head", "HeadTop_End", "LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand", "LeftHandMiddle1", "RightHandMiddle1"];
    const missing = need.filter(n => !this.b[n]);
    if (missing.length) console.warn("Avatar3D: missing bones", missing);

    // rest pose: world rotation of every driven bone + the direction it points (to its child)
    this.group.updateMatrixWorld(true);
    const wp = n => this.b[n].getWorldPosition(new THREE.Vector3());
    const wq = n => this.b[n].getWorldQuaternion(new THREE.Quaternion());
    this.rest = {};
    for (const [bone, child] of [["LeftArm", "LeftForeArm"], ["LeftForeArm", "LeftHand"], ["LeftHand", "LeftHandMiddle1"],
                                 ["RightArm", "RightForeArm"], ["RightForeArm", "RightHand"], ["RightHand", "RightHandMiddle1"]]) {
      this.rest[bone] = { q: wq(bone), dir: wp(child).sub(wp(bone)).normalize() };
    }
    this.rest.Spine = { q: wq("Spine"), lat: wp("LeftArm").sub(wp("RightArm")).normalize(), up: wp("Neck").sub(wp("Spine")).normalize() };
    this.rest.Head = { q: wq("Head") };
    this.restBasis = { Spine: basisQuat(this.rest.Spine.lat, this.rest.Spine.up), Head: basisQuat(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)) };    // relaxed arm direction (used when an arm isn't visible): hanging down, slightly out
    this.relaxed = { Left: new THREE.Vector3(0.18, -1, 0).normalize(), Right: new THREE.Vector3(-0.18, -1, 0).normalize() };
    this.fit = null;
  }

  // rotate bone so its world rotation becomes qWorld (smoothed)
  _setWorld(bone, qWorld) {
    const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const local = parentQ.invert().multiply(qWorld);
    bone.quaternion.slerp(local, SMOOTH);
    bone.updateMatrixWorld(true);
  }

  // point bone along a world direction
  _aim(boneName, dir) {
    const r = this.rest[boneName];
    const q = new THREE.Quaternion().setFromUnitVectors(r.dir, dir.clone().normalize()).multiply(r.q);
    this._setWorld(this.b[boneName], q);
  }

  _pose(tracker, W, H) {
    const P = tracker.pose, Pw = tracker.poseWorld, F = tracker.face;

    // torso: shoulder line + spine direction
    if (P && Pw) {
      const lat = world(Pw[L_SH]).sub(world(Pw[R_SH]));
      const up = world(Pw[L_SH]).add(world(Pw[R_SH])).multiplyScalar(0.5)
        .sub(world(Pw[L_HIP]).add(world(Pw[R_HIP])).multiplyScalar(0.5));
      const q = basisQuat(lat, up).multiply(this.restBasis.Spine.clone().invert()).multiply(this.rest.Spine.q);
      this._setWorld(this.b.Spine, q);
    }

    // head: from the face mesh (pixel-space 3D: x right, y up, z toward camera)
    if (F) {
      const f = i => new THREE.Vector3(F[i].x * W, -F[i].y * H, -F[i].z * W);
      const lat = f(454).sub(f(234));          // your left cheek (image right) minus right cheek
      const up = f(10).sub(f(152));            // forehead minus chin
      const q = basisQuat(lat, up).multiply(this.restBasis.Head.clone().invert()).multiply(this.rest.Head.q);
      this._setWorld(this.b.Head, q);
    }

    // arms: upper arm, forearm, hand each point along your matching segment
    if (P && Pw) {
      for (const [side, sh, el, wr, pi, ix] of [["Left", L_SH, L_EL, L_WR, L_PI, L_IN], ["Right", R_SH, R_EL, R_WR, R_PI, R_IN]]) {
        const ok1 = vis(P[sh]) && vis(P[el]), ok2 = ok1 && vis(P[wr]);
        const upper = ok1 ? world(Pw[el]).sub(world(Pw[sh])) : this.relaxed[side];
        const fore = ok2 ? world(Pw[wr]).sub(world(Pw[el])) : this.relaxed[side];
        const hand = ok2 ? world(Pw[pi]).add(world(Pw[ix])).multiplyScalar(0.5).sub(world(Pw[wr])) : this.relaxed[side];
        this._aim(`${side}Arm`, upper);
        this._aim(`${side}ForeArm`, fore);
        this._aim(`${side}Hand`, hand);
      }
    }
  }

  // canvas (W×H, transparent) with the posed hero drawn over you, or null if you're not tracked
  render(tracker, W, H) {
    if (!tracker.face && !tracker.pose) return this.fit ? this.canvas : null;
    if (this.canvas.width !== W || this.canvas.height !== H) {
      this.renderer.setSize(W, H, false);
      Object.assign(this.camera, { left: 0, right: W, top: 0, bottom: -H }); this.camera.updateProjectionMatrix();
    }

    // pose at unit scale, then measure the hero's head in model space
    this.group.position.set(0, 0, 0); this.group.scale.setScalar(1); this.group.updateMatrixWorld(true);
    this._pose(tracker, W, H);
    const head = this.b.Head.getWorldPosition(new THREE.Vector3());
    const top = this.b.HeadTop_End.getWorldPosition(new THREE.Vector3());
    const heroHead = Math.hypot(top.x - head.x, top.y - head.y) || 1;
    const heroEye = head.clone().lerp(top, 0.45);

    // your head in the image: eye midpoint + chin->forehead length
    let target = null;
    if (tracker.face) {
      const F = tracker.face, px = i => ({ x: F[i].x * W, y: F[i].y * H });
      const a = px(33), b = px(263), chin = px(152), brow = px(10);
      target = { eye: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, len: Math.hypot(brow.x - chin.x, brow.y - chin.y) * 1.15 * COVER };
    } else if (tracker.pose) {
      const P = tracker.pose, px = i => ({ x: P[i].x * W, y: P[i].y * H });
      const eL = px(2), eR = px(5), ls = px(L_SH), rs = px(R_SH);
      target = { eye: { x: (eL.x + eR.x) / 2, y: (eL.y + eR.y) / 2 }, len: Math.hypot(ls.x - rs.x, ls.y - rs.y) * 0.62 * COVER };
    }
    const s = target.len / heroHead;
    const k = 0.5, f = this.fit;
    this.fit = f ? { s: f.s + (s - f.s) * k, x: f.x + (target.eye.x - f.x) * k, y: f.y + (target.eye.y - f.y) * k }
                 : { s, x: target.eye.x, y: target.eye.y };

    // place: hero eye -> your eye (screen y = -world y)
    this.group.scale.setScalar(this.fit.s);
    this.group.position.set(this.fit.x - heroEye.x * this.fit.s, -this.fit.y - heroEye.y * this.fit.s, 0);
    this.renderer.render(this.scene, this.camera);
    return this.canvas;
  }
}
