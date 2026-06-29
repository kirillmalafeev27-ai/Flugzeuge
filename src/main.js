/* =====================================================================
 * Оборона дирижабля — Zeppelin Defense
 * three.js + Rapier (debris physics) + three-pinata (Voronoi fracture)
 *
 * Modes:
 *   GUN    — stationary, aim within a ±45° cone, shoot enemies. Can't move.
 *   FLIGHT — fly the blue plane freely (spinning prop). Can't shoot, gun hidden.
 *
 * Mission: keep the airship alive for 2 minutes against waves of WW1 fighters.
 * On death, every plane / the airship is Voronoi-fractured and the chunks fall
 * with real rigid-body physics, burning and trailing smoke.
 * ===================================================================== */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { fracture, FractureOptions } from 'three-pinata';

const T = THREE;
const TOKEN = window.__T;
const V3 = (x, y, z) => new T.Vector3(x, y, z);
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
function randDir() {
  const u = Math.random(), v = Math.random(), th = u * 6.283, ph = Math.acos(2 * v - 1);
  return V3(Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th));
}

/* ============================ TUNABLES =============================== *
 * Orientation of imported models can't be eyeballed from code, so the few
 * rotation offsets that might need a nudge live here for quick tweaking.   */
const CFG = {
  PLAYER:  { size: 3.0,  rot: [0, -Math.PI / 2, 0], color: 0x2f6bd8 }, // nose -X -> -Z
  ENEMY:   { size: 2.6,  rot: [0, 0, 0] },                              // nose along -Z
  AIRSHIP: { size: 34,   rot: [0, Math.PI / 2, 0] },                    // long side to camera
  GUN:     { size: 1.5,  rot: [0, 0, 0] },                              // barrel -Z
  PROP_RPS: 22,            // propeller revolutions / second (~realistic WW1 idle/cruise)
  ROUND_TIME: 120,         // seconds to survive
  AIM_CONE: Math.PI / 4,   // ±45°
  AMMO_START: 60, AMMO_RELOAD: 30, AMMO_MAX: 240,
  SHIP_HP: 100, PLAYER_HP: 100, ENEMY_HP: 100,
  FLOOR: -22,
};

/* ============================ RENDERER ============================== */
const renderer = new T.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = T.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new T.Scene();
const camera = new T.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 3000);
camera.position.set(0, 4, 12);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/* lights — HDR provides ambient/reflections, these add shape + shadow */
const sun = new T.DirectionalLight(0xfff1da, 2.2);
sun.position.set(40, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 260;
sun.shadow.camera.left = -90; sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90; sun.shadow.camera.bottom = -90;
sun.shadow.bias = -0.0004;
scene.add(sun);
scene.add(new T.HemisphereLight(0xbcd4ff, 0x2a2620, 0.5));
const muzzleLight = new T.PointLight(0xffb060, 0, 14, 2); scene.add(muzzleLight);
let muzzleLightI = 0;

/* ============================ TEXTURES ============================== */
function cv(s) { const c = document.createElement('canvas'); c.width = c.height = s; return c; }
function tx(c) { const t = new T.CanvasTexture(c); t.needsUpdate = true; return t; }
function makeGlow() { const c = cv(128), x = c.getContext('2d'); const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.2, 'rgba(255,255,255,.9)');
  g.addColorStop(.5, 'rgba(255,255,255,.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128); return tx(c); }
function makeSpark() { const c = cv(64), x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.3, 'rgba(255,255,255,.55)');
  g.addColorStop(.65, 'rgba(255,255,255,.1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64); return tx(c); }
function makeSmoke() { const c = cv(160), x = c.getContext('2d');
  for (let i = 0; i < 14; i++) { const px = 40 + Math.random() * 80, py = 40 + Math.random() * 80, r = 22 + Math.random() * 34;
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, 'rgba(255,255,255,.4)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill(); } return tx(c); }
function makeRing() { const c = cv(160), x = c.getContext('2d'); const g = x.createRadialGradient(80, 80, 0, 80, 80, 80);
  g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.62, 'rgba(255,255,255,0)');
  g.addColorStop(.74, 'rgba(255,255,255,.85)'); g.addColorStop(.82, 'rgba(255,255,255,.35)');
  g.addColorStop(.9, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 160, 160); return tx(c); }
function makeStar() { const c = cv(128), x = c.getContext('2d'); x.translate(64, 64);
  let g = x.createRadialGradient(0, 0, 0, 0, 0, 58);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.25, 'rgba(255,240,200,.8)'); g.addColorStop(1, 'rgba(255,170,70,0)');
  x.fillStyle = g; x.beginPath(); x.arc(0, 0, 58, 0, 7); x.fill(); x.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 6; i++) { x.save(); x.rotate(i * Math.PI / 3 + .25);
    const gg = x.createLinearGradient(0, 0, 60, 0);
    gg.addColorStop(0, 'rgba(255,235,190,.95)'); gg.addColorStop(1, 'rgba(255,170,70,0)');
    x.fillStyle = gg; x.beginPath(); x.moveTo(0, -5); x.lineTo(60, 0); x.lineTo(0, 5); x.closePath(); x.fill(); x.restore(); }
  return tx(c); }
const TEX = { glow: makeGlow(), spark: makeSpark(), smoke: makeSmoke(), ring: makeRing(), star: makeStar() };

/* ============================ PARTICLES ============================= */
const GR = {
  fire: [[0, [1, .96, .8]], [.22, [1, .62, .22]], [.55, [.86, .24, .07]], [1, [.18, .05, .03]]],
  spark: [[0, [1, 1, .86]], [.5, [1, .72, .32]], [1, [1, .38, .1]]],
  ember: [[0, [1, .66, .3]], [1, [.7, .2, .06]]],
  smoke: [[0, [.42, .34, .3]], [.45, [.24, .24, .26]], [1, [.09, .09, .11]]],
  msmoke: [[0, [.5, .48, .46]], [1, [.15, .15, .16]]],
  trail: [[0, [.6, .42, .32]], [.3, [.32, .28, .27]], [1, [.08, .08, .09]]],
  flash: [[0, [1, 1, .95]], [1, [1, .7, .35]]],
  ringc: [[0, [1, .85, .6]], [1, [1, .5, .2]]],
};
function gcol(s, t) { for (let i = 0; i < s.length - 1; i++) { const a = s[i], b = s[i + 1];
  if (t <= b[0]) { const k = (t - a[0]) / (b[0] - a[0] || 1);
    return [a[1][0] + (b[1][0] - a[1][0]) * k, a[1][1] + (b[1][1] - a[1][1]) * k, a[1][2] + (b[1][2] - a[1][2]) * k]; } }
  return s[s.length - 1][1]; }
const parts = [];
const easeOut = t => 1 - Math.pow(1 - t, 3);
function spawn(o) {
  if (parts.length > 1400) return;
  const m = new T.SpriteMaterial({ map: o.map, color: 0xffffff, transparent: true, blending: o.blend, depthWrite: false, opacity: 0, rotation: o.rot0 || 0 });
  const s = new T.Sprite(m); s.position.copy(o.pos); s.scale.set(o.s0, o.s0, 1); scene.add(s);
  parts.push({ obj: s, mat: m, vel: o.vel, age: 0, life: o.life, delay: o.delay || 0, s0: o.s0, s1: o.s1, grav: o.grav, drag: o.drag, rot: o.rot || 0, grad: o.grad, op: o.op, bright: o.bright });
}
const opFire = t => Math.min(1, t / .05) * Math.pow(1 - t, 1.7);
const opSpark = t => Math.pow(1 - t, 1.5);
const opEmber = (t, a) => Math.pow(1 - t, 1.2) * (.55 + .45 * Math.sin(a * 38));
const opSmoke = t => Math.pow(Math.sin(Math.PI * t), .7);
const opFlash = t => Math.pow(1 - t, 2.3);
const opRing = t => Math.min(1, t / .04) * Math.pow(1 - t, 1.9);
function updateParticles(dt) {
  for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i];
    if (p.delay > 0) { p.delay -= dt; p.mat.opacity = 0; continue; }
    p.age += dt; const t = p.age / p.life;
    if (t >= 1) { scene.remove(p.obj); p.mat.dispose(); parts.splice(i, 1); continue; }
    p.vel.y += p.grav * dt; p.vel.multiplyScalar(Math.max(0, 1 - p.drag * dt));
    p.obj.position.addScaledVector(p.vel, dt);
    const s = p.s0 + (p.s1 - p.s0) * easeOut(t); p.obj.scale.set(s, s, 1);
    const c = gcol(p.grad, t); p.mat.color.setRGB(c[0], c[1], c[2]);
    p.mat.opacity = p.op(t, p.age) * p.bright;
    if (p.rot) p.mat.rotation += p.rot * dt; }
}
function impact(pos, nrm, power) { power = power || 1;
  spawn({ map: TEX.glow, blend: T.AdditiveBlending, pos: pos.clone(), vel: V3(), s0: .3, s1: rnd(1, 1.6) * power, life: .16, grav: 0, drag: 0, grad: GR.flash, op: opFlash, bright: 1 });
  const cone = nrm.clone().normalize();
  for (let i = 0; i < Math.round(14 * power); i++) { const d = randDir().multiplyScalar(.7).add(cone).normalize();
    spawn({ map: TEX.spark, blend: T.AdditiveBlending, pos: pos.clone(), vel: d.multiplyScalar(rnd(3, 9) * power), s0: rnd(.07, .14), s1: .03, life: rnd(.25, .5), grav: -8, drag: .7, grad: GR.spark, op: opSpark, bright: 1 }); }
  for (let i = 0; i < Math.round(4 * power); i++)
    spawn({ map: TEX.smoke, blend: T.NormalBlending, pos: pos.clone(), vel: randDir().multiplyScalar(rnd(.4, 1.2)).add(V3(0, .6, 0)), s0: .3, s1: rnd(.9, 1.5), life: rnd(.7, 1.3), grav: .5, drag: 1.6, rot0: Math.random() * 6, rot: rnd(-1, 1), grad: GR.smoke, op: opSmoke, bright: .4 });
}
function bigBoom(pos, power) { power = power || 1.2; shake = Math.min(1.6, shake + .7 * power);
  for (let i = 0; i < 2; i++) spawn({ map: TEX.glow, blend: T.AdditiveBlending, pos: pos.clone(), vel: V3(), s0: .6, s1: rnd(4, 6.5) * power, life: rnd(.16, .22), grav: 0, drag: 0, grad: GR.flash, op: opFlash, bright: 1 });
  spawn({ map: TEX.ring, blend: T.AdditiveBlending, pos: pos.clone(), vel: V3(), s0: .4, s1: rnd(9, 12) * power, life: .5, grav: 0, drag: 0, grad: GR.ringc, op: opRing, bright: .95 });
  for (let i = 0; i < Math.round(30 * power); i++) { const d = randDir(); d.y += rnd(0, .6);
    spawn({ map: TEX.glow, blend: T.AdditiveBlending, pos: pos.clone().addScaledVector(randDir(), .25), vel: d.multiplyScalar(rnd(2.5, 8) * power), s0: rnd(.35, .8), s1: rnd(2, 3.2) * power, life: rnd(.5, .9), grav: .8, drag: 1.9, grad: GR.fire, op: opFire, bright: 1 }); }
  for (let i = 0; i < Math.round(40 * power); i++)
    spawn({ map: TEX.spark, blend: T.AdditiveBlending, pos: pos.clone(), vel: randDir().multiplyScalar(rnd(7, 20) * power), s0: rnd(.1, .2), s1: .04, life: rnd(.35, .7), grav: -10, drag: .6, grad: GR.spark, op: opSpark, bright: 1 });
  const puff = (delay, n) => { for (let i = 0; i < n; i++) { const d = randDir(); d.y = Math.abs(d.y) + rnd(.4, 1.6);
    spawn({ map: TEX.smoke, blend: T.NormalBlending, pos: pos.clone().addScaledVector(randDir(), .4), vel: d.multiplyScalar(rnd(.6, 2) * power), s0: rnd(.8, 1.4), s1: rnd(3, 5) * power, life: rnd(1.6, 3), grav: .8, drag: 1.6, rot0: Math.random() * 6, rot: rnd(-.8, .8), grad: GR.smoke, op: opSmoke, bright: .55, delay }); } };
  puff(0, Math.round(9 * power)); puff(.12, Math.round(6 * power)); puff(.26, Math.round(4 * power));
}
function muzzleFlash(pos, dir) {
  const fwd = pos.clone().addScaledVector(dir, .15);
  spawn({ map: TEX.glow, blend: T.AdditiveBlending, pos: fwd.clone(), vel: V3(), s0: .2, s1: rnd(1.4, 2.0), life: .05, grav: 0, drag: 0, grad: GR.flash, op: opFlash, bright: 1 });
  spawn({ map: TEX.star, blend: T.AdditiveBlending, pos: fwd.clone(), vel: V3(), s0: .4, s1: rnd(1.8, 2.6), life: .06, grav: 0, drag: 0, rot0: Math.random() * 6, grad: GR.flash, op: opFlash, bright: 1 });
  for (let i = 0; i < 5; i++) spawn({ map: TEX.spark, blend: T.AdditiveBlending, pos: fwd.clone(), vel: dir.clone().multiplyScalar(rnd(6, 14)).add(randDir().multiplyScalar(2)), s0: rnd(.06, .12), s1: .02, life: rnd(.1, .22), grav: 0, drag: 1, grad: GR.spark, op: opSpark, bright: 1 });
}

/* ============================ TRACERS ============================== */
const TRACER_LEN = 1.8, TRACER_R = 0.05;
const tracerGeo = new T.CylinderGeometry(TRACER_R, TRACER_R, TRACER_LEN, 6); tracerGeo.rotateX(Math.PI / 2);
const tracerMatMine = new T.MeshBasicMaterial({ color: 0xffd070, transparent: true, opacity: .95, blending: T.AdditiveBlending, depthWrite: false });
const tracerMatEnemy = new T.MeshBasicMaterial({ color: 0xff5a3c, transparent: true, opacity: .9, blending: T.AdditiveBlending, depthWrite: false });
const tracers = []; const _q = new T.Quaternion(), _zAxis = V3(0, 0, 1);
function spawnTracer(pos, dir, dist, mine) {
  const mesh = new T.Mesh(tracerGeo, mine ? tracerMatMine : tracerMatEnemy);
  _q.setFromUnitVectors(_zAxis, dir); mesh.quaternion.copy(_q); scene.add(mesh);
  const head = new T.Sprite(new T.SpriteMaterial({ map: TEX.glow, color: mine ? 0xffe89a : 0xff8a5a, transparent: true, opacity: .9, blending: T.AdditiveBlending, depthWrite: false }));
  head.scale.set(.35, .35, 1); scene.add(head);
  tracers.push({ mesh, head, pos: pos.clone(), dir: dir.clone(), speed: rnd(150, 175), traveled: 0, max: dist || 220 });
}
function updateTracers(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) { const tr = tracers[i];
    const step = tr.speed * dt; tr.traveled += step; tr.pos.addScaledVector(tr.dir, step);
    tr.mesh.position.copy(tr.pos).addScaledVector(tr.dir, -TRACER_LEN * .5); tr.head.position.copy(tr.pos);
    if (tr.traveled >= tr.max) { scene.remove(tr.mesh); scene.remove(tr.head); tr.head.material.dispose(); tracers.splice(i, 1); } }
}

/* ============================ RAPIER DEBRIS ========================= */
let world = null;
const debris = [];
const DEBRIS_CAP = 90;
function initPhysics() {
  world = new RAPIER.World({ x: 0, y: -16, z: 0 });
  // ground plane so chunks land + bounce
  world.createCollider(RAPIER.ColliderDesc.cuboid(1200, 0.5, 1200).setTranslation(0, CFG.FLOOR - 0.5, 0));
}
const _wp = new T.Vector3(), _wq = new T.Quaternion(), _ws = new T.Vector3();
const _bs = new T.Vector3();

/* Fracture a single mesh into Rapier rigid bodies. */
function fractureMesh(mesh, center, baseVel, count, tint) {
  mesh.updateWorldMatrix(true, false);
  mesh.matrixWorld.decompose(_wp, _wq, _ws);
  const ws = _ws.clone(), wp = _wp.clone(), wq = _wq.clone();
  let frags = null;
  const vcount = mesh.geometry.attributes.position.count;
  if (mesh.geometry.index && vcount <= 12000) {
    try {
      const opt = new FractureOptions();
      opt.fragmentCount = count; opt.fractureMode = 'Convex'; opt.fracturePlanes = { x: true, y: true, z: true };
      frags = fracture(mesh, opt).map(f => f.toGeometry());
    } catch (e) { frags = null; }
  }
  if (!frags) frags = proxyFragments(mesh.geometry, count);  // bbox-box fallback

  const baseColor = tint || (mesh.material && mesh.material.color ? mesh.material.color.getHex() : 0x7a7f88);
  for (const g of frags) {
    g.scale(ws.x, ws.y, ws.z);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const out = new T.MeshStandardMaterial({ color: baseColor, metalness: .55, roughness: .55, emissive: 0x401505, emissiveIntensity: 1 });
    const inn = new T.MeshStandardMaterial({ color: 0x16181c, metalness: .4, roughness: .85, emissive: 0x3a1402, emissiveIntensity: 0.6 });
    const mat = [out, inn];
    const m = new T.Mesh(g, mat); m.castShadow = true; m.position.copy(wp); m.quaternion.copy(wq); scene.add(m);

    const rb = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(wp.x, wp.y, wp.z).setRotation({ x: wq.x, y: wq.y, z: wq.z, w: wq.w })
      .setLinearDamping(0.15).setAngularDamping(0.25));
    const pts = g.attributes.position.array;
    let cd = RAPIER.ColliderDesc.convexHull(pts) || RAPIER.ColliderDesc.ball(0.25);
    cd.setRestitution(0.25).setFriction(0.8).setDensity(1.2);
    world.createCollider(cd, rb);

    // explosion impulse: outward from fragment local centre + inherited velocity
    const fc = g.boundingSphere.center.clone().applyQuaternion(wq);
    const wpc = wp.clone().add(fc);
    const dir = wpc.clone().sub(center); dir.y = Math.abs(dir.y) + 0.4; dir.normalize();
    const vel = dir.multiplyScalar(rnd(4, 11)).addScaledVector(randDir(), 2).add(baseVel || V3());
    rb.setLinvel({ x: vel.x, y: vel.y + rnd(1, 4), z: vel.z }, true);
    rb.setAngvel({ x: rnd(-9, 9), y: rnd(-9, 9), z: rnd(-9, 9) }, true);

    debris.push({ mesh: m, rb, mats: mat, life: 0, emitT: 0, phase: Math.random() * 6 });
  }
  trimDebris();
}
function proxyFragments(geometry, count) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, s = new T.Vector3(); b.getSize(s); const c = new T.Vector3(); b.getCenter(c);
  const box = new T.BoxGeometry(Math.max(s.x, .2), Math.max(s.y, .2), Math.max(s.z, .2), 2, 2, 2).translate(c.x, c.y, c.z);
  const opt = new FractureOptions();
  opt.fragmentCount = count; opt.fractureMode = 'Convex'; opt.fracturePlanes = { x: true, y: true, z: true };
  return fracture(new T.Mesh(box), opt).map(f => f.toGeometry());
}
function trimDebris() {
  while (debris.length > DEBRIS_CAP) { const d = debris.shift(); removeDebris(d); }
}
function removeDebris(d) {
  scene.remove(d.mesh); d.mesh.geometry.dispose(); d.mats.forEach(m => m.dispose());
  if (d.rb && world) world.removeRigidBody(d.rb);
}
function trailPuff(pos) {
  spawn({ map: TEX.smoke, blend: T.NormalBlending, pos: pos.clone().add(randDir().multiplyScalar(.1)), vel: randDir().multiplyScalar(.25).add(V3(0, .4, 0)), s0: .35, s1: rnd(1.6, 2.4), life: rnd(1.1, 1.8), grav: .3, drag: 1.4, rot0: Math.random() * 6, rot: rnd(-1, 1), grad: GR.trail, op: opSmoke, bright: .6 });
}
function trailGlow(pos) {
  spawn({ map: TEX.glow, blend: T.AdditiveBlending, pos: pos.clone(), vel: randDir().multiplyScalar(.3), s0: .1, s1: rnd(.3, .6), life: rnd(.2, .4), grav: .2, drag: 1, grad: GR.fire, op: opFire, bright: .9 });
}
function updateDebris(dt) {
  if (!world) return;
  world.step();
  for (let i = debris.length - 1; i >= 0; i--) { const d = debris[i];
    const p = d.rb.translation(), r = d.rb.rotation();
    d.mesh.position.set(p.x, p.y, p.z); d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    d.life += dt;
    const fl = .45 + .55 * Math.abs(Math.sin(d.life * 20 + d.phase));
    d.mats[0].emissive.setRGB(.7 * fl, .26 * fl, .06 * fl);
    d.emitT -= dt;
    if (d.emitT <= 0) { d.emitT = .05; trailPuff(d.mesh.position);
      if (Math.random() < .5) trailGlow(d.mesh.position);
      if (Math.random() < .3) spawn({ map: TEX.spark, blend: T.AdditiveBlending, pos: d.mesh.position.clone(), vel: randDir().multiplyScalar(rnd(.5, 2)), s0: rnd(.05, .1), s1: .02, life: rnd(.3, .7), grav: -2, drag: 1, grad: GR.ember, op: opEmber, bright: 1 }); }
    if (p.y < CFG.FLOOR + 0.6 || d.life > 9) { impact(d.mesh.position.clone(), V3(0, 1, 0), .6); removeDebris(d); debris.splice(i, 1); } }
}

/* ============================ ASSETS =============================== */
const gltfLoader = new GLTFLoader(); gltfLoader.setRequestHeader({ 'x-game-token': TOKEN });
const hdrLoader = new RGBELoader(); hdrLoader.setRequestHeader({ 'x-game-token': TOKEN });
function loadGLB(name) { return new Promise((res, rej) => gltfLoader.load('/asset/' + name, g => res(g), undefined, rej)); }
function loadHDR(name) { return new Promise((res, rej) => hdrLoader.load('/asset/' + name, t => res(t), undefined, rej)); }

/* wrap a loaded scene in a centred, scaled pivot with given target size */
function normalize(obj, size, rot) {
  const pivot = new T.Group();
  if (rot) obj.rotation.set(rot[0] || 0, rot[1] || 0, rot[2] || 0);
  pivot.add(obj); pivot.updateWorldMatrix(true, true);
  const box = new T.Box3().setFromObject(obj); const c = new T.Vector3(); box.getCenter(c);
  const s = new T.Vector3(); box.getSize(s);
  obj.position.sub(c);
  const k = size / Math.max(s.x, s.y, s.z, 1e-3); pivot.scale.setScalar(k);
  return { pivot, dim: s.clone().multiplyScalar(k) };
}
function enableShadows(o, cast = true, receive = false) {
  o.traverse(n => { if (n.isMesh) { n.castShadow = cast; n.receiveShadow = receive; if (n.material) n.material.envMapIntensity = 1.1; } });
}

/* ============================ HUD refs ============================= */
const $ = id => document.getElementById(id);
const ui = {
  shipHpv: $('shipHpv'), shipBar: $('shipBar'), shipWrap: $('shipWrap'),
  meHpv: $('meHpv'), meBar: $('meBar'), meWrap: $('meWrap'),
  enemyCount: $('enemyCount'), kills: $('kills'), time: $('time'),
  ammo: $('ammo'), ammoBox: $('ammoBox'), reloadBtn: $('reloadBtn'), modeBtn: $('modeBtn'),
  modeName: $('modeName'), modeDot: $('modeDot'), reticle: $('reticle'), hm: $('hm'), dmg: $('dmg'),
  hint: $('hint'), loading: $('loading'), loadBar: $('loadBar'), loadMsg: $('loadMsg'),
  start: $('start'), startBtn: $('startBtn'), end: $('end'), endIcon: $('endIcon'),
  endTitle: $('endTitle'), endMsg: $('endMsg'), againBtn: $('againBtn'),
};

/* ============================ GAME STATE ========================== */
const G = {
  mode: 'gun', running: false, over: false,
  shipHp: CFG.SHIP_HP, meHp: CFG.PLAYER_HP, ammo: CFG.AMMO_START,
  kills: 0, timeLeft: CFG.ROUND_TIME,
  yaw: 0, pitch: 0,        // gun aim within cone
};
let player = null, propeller = null, airship = null, gun = null;
let enemyTpl = null;       // template gltf scene for cloning
const enemies = [];
const flight = { pos: V3(0, 6, 16), yaw: Math.PI, pitch: 0, roll: 0, speed: 14 };
// Gun mode is anchored to wherever the plane currently is + whichever way its
// nose points — NOT a fixed point in space. Frozen on entering gun mode.
const gunBase = { pos: new T.Vector3(), quat: new T.Quaternion() };
let shake = 0;

/* ============================ BUILD WORLD ========================= */
async function boot() {
  await RAPIER.init();
  initPhysics();

  const steps = ['sky.hdr', 'airship.glb', 'player_plane.glb', 'machine_gun.glb', 'enemy_ww1.glb'];
  let done = 0; const tick = () => { ui.loadBar.style.width = Math.round(++done / steps.length * 100) + '%'; };

  // sky
  ui.loadMsg.textContent = 'Загрузка неба…';
  const hdr = await loadHDR('sky.hdr');
  const pmrem = new T.PMREMGenerator(renderer); pmrem.compileEquirectangularShader();
  const env = pmrem.fromEquirectangular(hdr).texture;
  scene.environment = env; scene.background = env;
  hdr.dispose(); pmrem.dispose(); tick();

  // airship
  ui.loadMsg.textContent = 'Сборка дирижабля…';
  const ag = await loadGLB('airship.glb');
  const an = normalize(ag.scene, CFG.AIRSHIP.size, CFG.AIRSHIP.rot);
  airship = an.pivot; airship.position.set(0, 10, -36);
  enableShadows(airship, true, true); scene.add(airship); tick();

  // player plane — keep its ORIGINAL texture (just stop it mirroring the sky)
  ui.loadMsg.textContent = 'Подготовка борта…';
  const pg = await loadGLB('player_plane.glb');
  fixOriginalMaterial(pg.scene);
  const pn = normalize(pg.scene, CFG.PLAYER.size, CFG.PLAYER.rot);
  player = pn.pivot; enableShadows(player, true, false);
  propeller = null;
  player.traverse(n => { if (/проп|prop/i.test(n.name)) propeller = n; });
  scene.add(player); tick();

  // machine gun (the gun is one half; "the cabin" — your plane — is the other half)
  ui.loadMsg.textContent = 'Установка пулемёта…';
  const gunG = await loadGLB('machine_gun.glb');
  const gn = normalize(gunG.scene, CFG.GUN.size, CFG.GUN.rot);
  gun = gn.pivot; enableShadows(gun, true, false); scene.add(gun); tick();

  // enemy template
  ui.loadMsg.textContent = 'Подъём эскадрильи…';
  const eg = await loadGLB('enemy_ww1.glb');
  enemyTpl = eg.scene;

  // ground haze plane (subtle, for reference + shadow catch far below)
  const groundMat = new T.MeshStandardMaterial({ color: 0x3a4a5e, roughness: 1, metalness: 0, transparent: true, opacity: .5 });
  const ground = new T.Mesh(new T.PlaneGeometry(2000, 2000), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = CFG.FLOOR; ground.receiveShadow = true; scene.add(ground);

  scene.fog = new T.FogExp2(0x9fb6cf, 0.0016);

  ui.loading.classList.add('hidden');
  ui.start.classList.remove('hidden');
}

/* ============================ ENEMIES ============================= */
// Keep the model's OWN baseColor texture. The glTF material defaults to
// metalness=1, which makes it mirror the sky (the blue/red wash). Force it
// non-metallic so the original livery shows through.
function fixOriginalMaterial(root) {
  root.traverse(nd => {
    if (!nd.isMesh || !nd.material) return;
    const apply = m => { m.metalness = 0; if (m.roughness == null || m.roughness > 0.98) m.roughness = 0.85; m.envMapIntensity = 0.6; m.needsUpdate = true; };
    Array.isArray(nd.material) ? nd.material.forEach(apply) : apply(nd.material);
  });
}
function makeEnemy() {
  const clone = cloneSkinned(enemyTpl);
  fixOriginalMaterial(clone);
  const n = normalize(clone, CFG.ENEMY.size, CFG.ENEMY.rot);
  const obj = n.pivot; enableShadows(obj, true, false);
  // spawn far out on a ring around the airship, all heading inbound
  const ang = rnd(0, Math.PI * 2), R = rnd(95, 135);
  const sp = airship.position.clone().add(V3(Math.cos(ang) * R, rnd(-4, 18), Math.sin(ang) * R));
  obj.position.copy(sp);
  faceForward(obj, airship.position); // nose inbound from the start
  scene.add(obj);
  const e = {
    obj, hp: CFG.ENEMY_HP, state: 'approach', speed: rnd(22, 30),
    fireT: rnd(.3, 1), pursuer: Math.random() < 0.45, passes: 0, roll: 0, alive: true, target: 'ship',
  };
  enemies.push(e);
}
function cloneSkinned(o) { return o.clone(true); }
// Orient an object so its NOSE (-Z) points at target. (Object3D.lookAt points +Z,
// which would aim the tail at the target.)
const _faceM = new T.Matrix4();
function faceForward(obj, target) {
  _faceM.lookAt(obj.position, target, _up); // Matrix4.lookAt: -Z column points obj->target
  obj.quaternion.setFromRotationMatrix(_faceM);
}

// Smoothly rotate the plane so its nose (-Z) turns toward `desired` and fly forward.
// Adds a little bank (roll) into the turn for life. Returns nothing; always moves.
const _fwd = new T.Vector3(), _newFwd = new T.Vector3(), _lookM = new T.Matrix4(), _lookQ = new T.Quaternion(), _up = V3(0, 1, 0), _ZERO = new T.Vector3();
function flyToward(e, desired, dt, turnRate) {
  const obj = e.obj;
  _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
  _newFwd.copy(_fwd).lerp(desired, clamp(turnRate * dt, 0, 1));
  if (_newFwd.lengthSq() < 1e-6) _newFwd.copy(_fwd); else _newFwd.normalize();
  // bank into the turn: how much we're turning left/right
  const turnSign = Math.sign(_fwd.clone().cross(_newFwd).dot(_up));
  const turnMag = _fwd.angleTo(_newFwd);
  e.roll = lerp(e.roll, clamp(-turnSign * turnMag * 8, -0.9, 0.9), clamp(4 * dt, 0, 1));
  // build orientation whose -Z (nose) points along _newFwd, then roll around it
  _lookM.lookAt(_ZERO, _newFwd, _up); // Matrix4.lookAt: -Z column points toward target
  _lookQ.setFromRotationMatrix(_lookM);
  const rollQ = new T.Quaternion().setFromAxisAngle(_newFwd, e.roll);
  obj.quaternion.copy(rollQ.multiply(_lookQ));
  obj.position.addScaledVector(_newFwd, e.speed * dt);
}

function updateEnemies(dt) {
  ui.enemyCount.textContent = enemies.length;
  const ship = airship.position;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i]; if (!e.alive) continue;
    const obj = e.obj;
    const distShip = obj.position.distanceTo(ship);

    if (e.state === 'chase') {
      // pursuer that broke off: hunt the player and shoot at them
      const desired = player.position.clone().sub(obj.position); const d = desired.length(); desired.normalize();
      flyToward(e, desired, dt, 1.3);
      e.fireT -= dt;
      const near = clamp(1 - d / 90, 0, 1);
      if (e.fireT <= 0 && d < 90) { e.fireT = lerp(1.6, 0.45, near); e.target = 'player'; enemyFire(e, player.position, near); }
      // if we overshoot the player badly, swing back around
      if (d > 140) { /* keep chasing, flyToward will curve back */ }
    } else if (e.state === 'approach') {
      // run in on the airship, firing more accurately the closer we get
      const desired = ship.clone().sub(obj.position).normalize();
      flyToward(e, desired, dt, 1.1);
      e.fireT -= dt;
      const near = clamp(1 - distShip / 110, 0, 1);
      if (e.fireT <= 0 && distShip < 110) { e.fireT = lerp(1.5, 0.4, near); e.target = 'ship'; enemyFire(e, ship, near); }
      if (distShip < 24) e.state = 'pass';
    } else if (e.state === 'pass') {
      // punch straight through, past the airship
      _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
      e.roll = lerp(e.roll, 0, clamp(4 * dt, 0, 1));
      const rollQ = new T.Quaternion().setFromAxisAngle(_fwd, e.roll);
      // keep current heading (no steer) — just fly forward
      obj.position.addScaledVector(_fwd, e.speed * dt);
      if (distShip > 55) { e.passes++; e.state = (e.pursuer && e.passes >= 1) ? 'chase' : 'turn'; }
    } else if (e.state === 'turn') {
      // out beyond the airship: bank hard and come back around for another run
      const desired = ship.clone().sub(obj.position).normalize();
      flyToward(e, desired, dt, 1.9);
      _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
      if (_fwd.dot(desired) > 0.75) e.state = 'approach'; // now pointing back at the airship
    }

    if (obj.position.y < CFG.FLOOR + 8) obj.position.y = CFG.FLOOR + 8;
    if (obj.position.y > 80) obj.position.y = 80;
    // if a chaser/turner wanders too far, fold it back into an approach
    if (distShip > 260) { faceForward(obj, ship); e.state = "approach"; }
  }
}

function enemyFire(e, targetPos, near) {
  const muzzle = e.obj.position.clone().add(V3(0, 0, -1).applyQuaternion(e.obj.quaternion).multiplyScalar(CFG.ENEMY.size * .6));
  const dir = targetPos.clone().sub(muzzle).normalize();
  // visual scatter
  dir.x += rnd(-1, 1) * .03; dir.y += rnd(-1, 1) * .03; dir.normalize();
  spawnTracer(muzzle, dir, muzzle.distanceTo(targetPos) + 6, false);
  muzzleFlash(muzzle, dir);
  // hit chance scales with proximity
  if (Math.random() < near * 0.55) {
    if (e.target === 'player') { damagePlayer(Math.round(rnd(3, 7))); }
    else { damageShip(Math.round(rnd(2, 5)), targetPos); }
  }
}

/* ============================ DAMAGE / DEATH ====================== */
function damageShip(d, at) {
  if (G.over) return;
  G.shipHp = Math.max(0, G.shipHp - d);
  setShipHp();
  impact((at || airship.position).clone().add(randDir().multiplyScalar(3)).setY(airship.position.y + rnd(-3, 3)), V3(0, 1, 0), 1.1);
  if (G.shipHp <= 0) endGame(false, 'Дирижабль уничтожен.');
}
function damagePlayer(d) {
  if (G.over) return;
  G.meHp = Math.max(0, G.meHp - d); setMeHp();
  ui.dmg.style.opacity = clamp(d / 8, .3, 1); setTimeout(() => ui.dmg.style.opacity = 0, 120);
  shake = Math.min(1.4, shake + .25);
  if (G.meHp <= 0) endGame(false, 'Твой борт сбит.');
}
function killEnemy(e, at) {
  e.alive = false;
  const c = e.obj.position.clone();
  bigBoom(c, 1.25);
  const baseVel = V3(0, 0, -1).applyQuaternion(e.obj.quaternion).multiplyScalar(e.speed * .5);
  // re-resolve the live mesh under the placed pivot and Voronoi-fracture it
  let live = null; e.obj.traverse(n => { if (n.isMesh && (!live || n.geometry.attributes.position.count > live.geometry.attributes.position.count)) live = n; });
  if (live) { try { fractureMesh(live, c, baseVel, 9, ENEMY_COLOR); } catch (err) { console.warn('fracture failed', err); } }
  scene.remove(e.obj);
  const idx = enemies.indexOf(e); if (idx >= 0) enemies.splice(idx, 1);
  G.kills++; ui.kills.textContent = G.kills;
}

/* ============================ SHOOTING ============================ */
const ray = new T.Raycaster();
let firing = false, cooldown = 0; const FIRE_DT = 0.08;
let recoil = 0;
function fire() {
  if (G.ammo <= 0) { return; }
  // muzzle = a bit in front of the gun, along its forward
  gun.updateMatrixWorld();
  const muzzle = new T.Vector3(0, 0, -CFG.GUN.size * .55).applyMatrix4(gun.matrixWorld);
  const aimDir = V3(0, 0, -1).applyQuaternion(camera.quaternion); // camera & gun share aim
  const dir = aimDir.clone();
  dir.x += rnd(-1, 1) * .01; dir.y += rnd(-1, 1) * .01; dir.normalize();

  // raycast against enemies
  ray.set(muzzle, dir); ray.far = 300;
  let hitE = null, hitInfo = null;
  for (const e of enemies) {
    if (!e.alive) continue;
    const hs = ray.intersectObject(e.obj, true);
    if (hs.length) { if (!hitInfo || hs[0].distance < hitInfo.distance) { hitInfo = hs[0]; hitE = e; } }
  }
  const dist = hitInfo ? hitInfo.distance : 260;
  spawnTracer(muzzle, dir, dist, true);
  muzzleFlash(muzzle, dir);
  muzzleLight.position.copy(muzzle); muzzleLightI = 2.6;
  recoil = Math.min(1.4, recoil + 1); shake = Math.min(1.0, shake + .04);

  if (hitE && hitInfo) {
    const nrm = hitInfo.face ? hitInfo.face.normal.clone().transformDirection(hitInfo.object.matrixWorld) : dir.clone().negate();
    impact(hitInfo.point.clone(), nrm, 1);
    const v = hitInfo.point.clone().project(camera);
    popHM((v.x * .5 + .5) * innerWidth, (-v.y * .5 + .5) * innerHeight);
    hitE.hp -= Math.round(rnd(8, 14));
    if (hitE.hp <= 0) killEnemy(hitE, hitInfo.point);
  }
  G.ammo--; setAmmo();
}

/* ============================ INPUT ============================== */
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); toggleMode(); }
  if (e.code === 'KeyR') reload();
});
addEventListener('keyup', e => { keys[e.code] = false; });
// debug helpers (only with ?debug) — verify Voronoi+Rapier death without aiming
if (location.search.includes('debug')) {
  window.__spawnClose = () => { makeEnemy(); const e = enemies[enemies.length - 1]; const f = V3(0, 0, -1).applyQuaternion(gunBase.quat); e.obj.position.copy(gunBase.pos).addScaledVector(f, 30).add(V3(rnd(-6, 6), rnd(2, 8), 0)); e.pursuer = false; return e; };
  window.__killAll = () => { for (const e of enemies.slice()) if (e.alive) killEnemy(e, e.obj.position.clone()); };
  window.__state = () => ({ mode: G.mode, player: player.position.toArray().map(x => +x.toFixed(1)), cam: camera.position.toArray().map(x => +x.toFixed(1)), enemies: enemies.map(e => ({ s: e.state, p: e.obj.position.toArray().map(x => +x.toFixed(1)) })) });
}
addEventListener('blur', () => { firing = false; for (const k in keys) keys[k] = false; });

let pointerLocked = false;
renderer.domElement.addEventListener('click', () => {
  if (G.running && G.mode === 'gun' && !pointerLocked) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => { pointerLocked = document.pointerLockElement === renderer.domElement; });
addEventListener('mousemove', e => {
  if (G.mode === 'gun' && pointerLocked) {
    G.yaw = clamp(G.yaw - e.movementX * 0.0022, -CFG.AIM_CONE, CFG.AIM_CONE);
    G.pitch = clamp(G.pitch - e.movementY * 0.0022, -CFG.AIM_CONE, CFG.AIM_CONE);
  }
});
renderer.domElement.addEventListener('pointerdown', () => { if (G.mode === 'gun') firing = true; });
addEventListener('pointerup', () => { firing = false; });

ui.modeBtn.onclick = toggleMode;
ui.reloadBtn.onclick = reload;
ui.startBtn.onclick = startGame;
ui.againBtn.onclick = () => location.reload();

function toggleMode() {
  if (!G.running) return;
  G.mode = G.mode === 'gun' ? 'flight' : 'gun';
  const gunMode = G.mode === 'gun';
  ui.modeName.textContent = gunMode ? 'Пулемёт' : 'Полёт';
  ui.modeBtn.firstChild.textContent = gunMode ? 'Полёт ' : 'Пулемёт ';
  ui.modeDot.style.background = gunMode ? 'var(--accent)' : 'var(--sky)';
  ui.modeDot.style.boxShadow = '0 0 12px 2px ' + (gunMode ? 'var(--accent)' : 'var(--sky)');
  ui.reticle.classList.toggle('show', gunMode);
  ui.hint.innerHTML = gunMode
    ? '<kbd>ЛКМ</kbd> огонь · <kbd>мышь</kbd> наводка (±45°) · <kbd>R</kbd> перезарядка · <kbd>TAB</kbd> в полёт'
    : '<kbd>W/S</kbd> тангаж · <kbd>A/D</kbd> крен · <kbd>Q/E</kbd> рыскание · <kbd>Shift/Ctrl</kbd> газ · <kbd>TAB</kbd> к пулемёту';
  if (!gunMode && pointerLocked) document.exitPointerLock();
  gun.visible = gunMode;
  if (gunMode) {
    // freeze the plane exactly where it is; the gun aims where the nose points
    gunBase.pos.copy(player.position);
    gunBase.quat.copy(player.quaternion);
    G.yaw = 0; G.pitch = 0;
  } else {
    // entering flight: resume flying from the plane's current pose
    flight.pos.copy(player.position);
    const f = V3(0, 0, -1).applyQuaternion(player.quaternion);
    flight.yaw = Math.atan2(-f.x, -f.z); // heading from current forward
    flight.pitch = Math.asin(clamp(f.y, -1, 1));
    flight.roll = 0;
  }
}
function reload() {
  if (!G.running) return;
  if (G.ammo >= CFG.AMMO_MAX) return;
  G.ammo = Math.min(CFG.AMMO_MAX, G.ammo + CFG.AMMO_RELOAD); setAmmo();
  ui.reloadBtn.classList.add('warm'); setTimeout(() => ui.reloadBtn.classList.remove('warm'), 180);
}

/* ============================ HUD setters ======================== */
function setShipHp() { ui.shipHpv.textContent = G.shipHp; ui.shipBar.style.width = G.shipHp + '%'; ui.shipWrap.classList.toggle('low', G.shipHp <= 30); }
function setMeHp() { ui.meHpv.textContent = G.meHp; ui.meBar.style.width = G.meHp + '%'; ui.meWrap.classList.toggle('low', G.meHp <= 30); }
function setAmmo() { ui.ammo.textContent = G.ammo; ui.ammoBox.classList.toggle('empty', G.ammo <= 0); }
function setTime() { const m = Math.floor(G.timeLeft / 60), s = Math.floor(G.timeLeft % 60); ui.time.textContent = m + ':' + String(s).padStart(2, '0'); }
function popHM(x, y) { ui.hm.style.left = x + 'px'; ui.hm.style.top = y + 'px'; ui.hm.classList.remove('go'); void ui.hm.offsetWidth; ui.hm.classList.add('go'); }

/* ============================ CAMERAS ============================ */
const _camTarget = new T.Vector3(), _camPos = new T.Vector3(), _look = new T.Vector3();
const _camRig = new T.Vector3(), _aimQ = new T.Quaternion(), _coneQ = new T.Quaternion(), _coneE = new T.Euler();
function updateGunCamera(dt) {
  // You sit in the plane's cockpit (frozen pose); the gun + view swivel within a
  // ±45° cone around the direction the nose is pointing. No teleport — you stay
  // exactly where the plane is.
  const cockpit = V3(0, 0.9, 0.35).applyQuaternion(gunBase.quat); // local: up + slightly behind cockpit
  _camRig.copy(gunBase.pos).add(cockpit);
  camera.position.lerp(_camRig, Math.min(1, 12 * dt)); // quick settle on mode switch
  // aim = base nose orientation, offset by yaw/pitch within the cone
  _coneE.set(G.pitch, G.yaw, 0, 'YXZ'); _coneQ.setFromEuler(_coneE);
  _aimQ.copy(gunBase.quat).multiply(_coneQ);
  camera.quaternion.copy(_aimQ);
  camera.position.x += (Math.random() - .5) * shake * .3;
  camera.position.y += (Math.random() - .5) * shake * .3;

  // gun mounted in front of the cockpit, swivelling with the aim
  const fwd = V3(0, 0, -1).applyQuaternion(camera.quaternion);
  const down = V3(0, -1, 0).applyQuaternion(camera.quaternion);
  gun.position.copy(camera.position).addScaledVector(fwd, 1.7 - recoil * .25).addScaledVector(down, .5);
  gun.quaternion.copy(camera.quaternion);
  gun.rotateX(-recoil * .12);
  recoil *= Math.pow(.0008, dt);
}
function updateFlight(dt) {
  // controls
  const pitchIn = (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0);
  const rollIn = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
  const yawIn = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
  flight.pitch += pitchIn * 1.4 * dt;
  flight.roll = lerp(flight.roll, -rollIn * 0.6, clamp(4 * dt, 0, 1));
  flight.yaw += yawIn * 1.0 * dt + rollIn * 0.5 * dt; // banking turns
  flight.pitch = clamp(flight.pitch, -1.1, 1.1);
  const throttle = (keys.ShiftLeft || keys.ShiftRight ? 1 : 0) - (keys.ControlLeft || keys.ControlRight ? 1 : 0);
  flight.speed = clamp(flight.speed + throttle * 12 * dt, 6, 34);

  const q = new T.Quaternion().setFromEuler(new T.Euler(flight.pitch, flight.yaw, flight.roll, 'YXZ'));
  const fwd = V3(0, 0, -1).applyQuaternion(q);
  flight.pos.addScaledVector(fwd, flight.speed * dt);
  flight.pos.y = clamp(flight.pos.y, CFG.FLOOR + 4, 90);

  player.position.copy(flight.pos); player.quaternion.copy(q);

  // chase camera
  const back = V3(0, 1.6, 7.5).applyQuaternion(q);
  _camPos.copy(flight.pos).add(back);
  camera.position.lerp(_camPos, 1 - Math.pow(0.0009, dt));
  _look.copy(flight.pos).addScaledVector(fwd, 8);
  camera.lookAt(_look);
  camera.position.x += (Math.random() - .5) * shake * .3;
  camera.position.y += (Math.random() - .5) * shake * .3;
}

/* ============================ SPAWN DIRECTOR ===================== */
let spawnT = 0, waveLevel = 0;
function updateSpawns(dt) {
  spawnT -= dt;
  const target = 3 + Math.floor((CFG.ROUND_TIME - G.timeLeft) / 24); // ramps up over time
  if (spawnT <= 0 && enemies.length < target) {
    makeEnemy(); spawnT = rnd(1.6, 3.2);
  }
}

/* ============================ GAME FLOW ========================= */
function startGame() {
  ui.start.classList.add('hidden');
  G.running = true;
  // start near the airship, nose pointed at it; gun will aim where the nose looks
  player.position.copy(airship.position).add(V3(16, -2, 30));
  faceForward(player, airship.position);
  flight.pos.copy(player.position);
  G.mode = 'flight'; toggleMode(); // flip to gun + sync hint (freezes current pose)
  ui.reticle.classList.add('show');
  for (let i = 0; i < 3; i++) makeEnemy();
}
async function endGame(won, msg) {
  if (G.over) return;
  G.over = true; G.running = false;
  firing = false; if (pointerLocked) document.exitPointerLock();
  ui.endIcon.textContent = won ? '🏆' : '💥';
  ui.endTitle.textContent = won ? 'Дирижабль удержан' : 'Поражение';
  ui.end.classList.toggle('win', won); ui.end.classList.toggle('lose', !won);
  ui.endMsg.textContent = `${msg}  Сбито: ${G.kills}.`;
  ui.end.classList.remove('hidden');
  try {
    const r = await fetch('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kills: G.kills, won, survived: CFG.ROUND_TIME - G.timeLeft }) });
    const j = await r.json(); if (j && j.best != null) ui.endMsg.textContent += `  Рекорд: ${j.best}.`;
  } catch (e) {}
}

/* ============================ MAIN LOOP ========================= */
const clock = new T.Clock(); let tt = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05); tt += dt;

  if (G.running && !G.over) {
    G.timeLeft -= dt; if (G.timeLeft <= 0) { G.timeLeft = 0; setTime(); endGame(true, 'Время вышло — ты выстоял.'); }
    setTime();
    updateSpawns(dt);
    updateEnemies(dt);

    // propeller spins faster in flight (with throttle), idles in gun mode
    if (propeller) {
      const rps = CFG.PROP_RPS * (G.mode === 'flight' ? (0.6 + flight.speed / 34 * 0.8) : 0.55);
      propeller.rotation.x += rps * Math.PI * 2 * dt;
    }

    if (G.mode === 'gun') {
      updateGunCamera(dt);
      cooldown -= dt;
      if (firing && G.ammo > 0 && cooldown <= 0) { fire(); cooldown = FIRE_DT; }
    } else {
      updateFlight(dt);
    }
  } else {
    // idle orbit before start
    camera.position.lerp(_camPos.set(Math.sin(tt * .15) * 26, 14, 30 + Math.cos(tt * .15) * 6), 0.02);
    if (airship) camera.lookAt(airship.position);
  }

  muzzleLightI *= Math.pow(.0001, dt); muzzleLight.intensity = muzzleLightI;
  updateTracers(dt); updateDebris(dt); updateParticles(dt);
  shake *= Math.pow(.02, dt);

  renderer.render(scene, camera);
}

/* ============================ GO =============================== */
boot().then(() => { setShipHp(); setMeHp(); setAmmo(); setTime(); frame(); })
  .catch(err => { ui.loadMsg.textContent = 'Ошибка загрузки: ' + err.message; console.error(err); });
