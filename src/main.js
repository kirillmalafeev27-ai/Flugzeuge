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
import { ActionQuizGate } from './action-quiz.js';

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
  AIM_SENS: 0.0042,        // gun mouse sensitivity (higher = turns faster)
  AMMO_START: 60, AMMO_RELOAD: 30, AMMO_MAX: 240,
  SHIP_HP: 100, PLAYER_HP: 100, ENEMY_HP: 100,
  FLOOR: -22,
  // --- balance ---
  ENEMY_SPEED: [5.8, 8.2],
  MAX_PURSUERS: 2,         // at most this many may peel off to chase you
  MAX_ENEMIES_BASE: 6,     // how many fighters in the sky early on
  MAX_ENEMIES_CAP: 12,     // hard cap as the wave ramps
  // Airship survival model (see shipDamageCap): if the player kills nobody the
  // wave can deliver SHIP_DMG_BUDGET × the hull (140% → guaranteed loss). Killing
  // SHIP_SURVIVE_KILL of the enemies that ever spawn (41%) is the break-even line;
  // above it the airship lives. The first sessions are eased in (see difficulty()).
  SHIP_DMG_BUDGET: 1.40,
  SHIP_SURVIVE_KILL: 0.41,
  CHASER_STANDOFF: 62,
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
function spawnTracer(pos, dir, dist, mine, onImpact = null) {
  const mesh = new T.Mesh(tracerGeo, mine ? tracerMatMine : tracerMatEnemy);
  _q.setFromUnitVectors(_zAxis, dir); mesh.quaternion.copy(_q); scene.add(mesh);
  const head = new T.Sprite(new T.SpriteMaterial({ map: TEX.glow, color: mine ? 0xffe89a : 0xff8a5a, transparent: true, opacity: .9, blending: T.AdditiveBlending, depthWrite: false }));
  head.scale.set(.35, .35, 1); scene.add(head);
  tracers.push({ mesh, head, pos: pos.clone(), dir: dir.clone(), speed: mine ? rnd(112, 126) : rnd(96, 112), traveled: 0, max: dist || 220, onImpact });
}
function updateTracers(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) { const tr = tracers[i];
    const step = Math.min(tr.speed * dt, Math.max(0, tr.max - tr.traveled)); tr.traveled += step; tr.pos.addScaledVector(tr.dir, step);
    tr.mesh.position.copy(tr.pos).addScaledVector(tr.dir, -TRACER_LEN * .5); tr.head.position.copy(tr.pos);
    if (tr.traveled >= tr.max) {
      if (tr.onImpact) tr.onImpact(tr.pos.clone());
      scene.remove(tr.mesh); scene.remove(tr.head); tr.head.material.dispose(); tracers.splice(i, 1);
    } }
}
// Wipe every transient effect so a restart starts on a clean scene without a
// full page reload (the old "Ещё раз" reloaded the page, which dumped you back
// to the menu). Shared tracer materials are reused, so only per-instance ones
// get disposed.
function clearTransients() {
  for (let i = parts.length - 1; i >= 0; i--) { scene.remove(parts[i].obj); parts[i].mat.dispose(); }
  parts.length = 0;
  for (let i = tracers.length - 1; i >= 0; i--) { const tr = tracers[i]; scene.remove(tr.mesh); scene.remove(tr.head); tr.head.material.dispose(); }
  tracers.length = 0;
  for (let i = debris.length - 1; i >= 0; i--) removeDebris(debris[i]);
  debris.length = 0;
  shake = 0;
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
  endTitle: $('endTitle'), endMsg: $('endMsg'), storyChoice: $('storyChoice'), storyCard: $('storyCard'), againBtn: $('againBtn'),
};

/* ============================ GAME STATE ========================== */
const G = {
  mode: 'gun', running: false, over: false,
  shipHp: CFG.SHIP_HP, meHp: CFG.PLAYER_HP, ammo: CFG.AMMO_START,
  kills: 0, spawned: 0, timeLeft: CFG.ROUND_TIME,
  gameIndex: -1,            // ++ each startGame; persists across a session so the
                           // first runs can be eased in (see difficulty())
  yaw: 0, pitch: 0,        // gun aim within cone
  quizActive: false, quizPausesCombat: false, actionPending: false, starting: false,
  evasion: 0, playerSmokeT: 0, cinematic: null, endDisplayed: false,
};
const actionQuiz = new ActionQuizGate({
  onActiveChange: active => {
    G.quizActive = active;
    if (active) {
      firing = false;
      if (pointerLocked) document.exitPointerLock();
    }
  },
});
const STORY_SELECTED_KEY = 'zeppelin-defense.story-selected.v1';
const STORY_PROGRESS_PREFIX = 'zeppelin-defense.story-progress.';
const AIRSHIP_STORIES = [
  {
    id: 'world80',
    title: 'In 80 Tagen um die Welt',
    subtitle: 'Eine Wette gegen die Zeit',
    description: 'Лондонский джентльмен Филеас Фогг спорит, что объедет вокруг света за 80 дней, и вместе со слугой Паспарту мчится сквозь страны и штормы.',
    fragments: [
      {
        title: 'Die Wette im Club',
        levels: {
          A1: 'Phileas Fogg ist ein ruhiger Mann aus London. Er sagt: Ich kann in 80 Tagen um die Welt reisen.',
          A2: 'Im Club spielt Phileas Fogg jeden Abend Karten. Heute macht er eine große Wette: In nur 80 Tagen will er um die ganze Welt reisen.',
          B1: 'Phileas Fogg war ein Gentleman, der jeden Tag dieselbe Routine hatte. Eines Abends wettete er im Club zwanzigtausend Pfund, dass er die Welt in achtzig Tagen umrunden könne.',
          B2: 'Phileas Fogg, ein Mann von eiserner Pünktlichkeit, galt im Reform-Club als Sonderling. An jenem Abend behauptete er, die gesamte Welt lasse sich in nur achtzig Tagen umrunden – und setzte sein halbes Vermögen auf diese kühne Wette.',
        },
      },
      {
        title: 'Die Abreise mit Passepartout',
        levels: {
          A1: 'Fogg hat einen neuen Diener. Er heißt Passepartout. Sie nehmen den Zug und fahren los.',
          A2: 'Foggs Diener heißt Passepartout. Am gleichen Abend packen sie eine Tasche, steigen in den Zug und beginnen die lange Reise nach Osten.',
          B1: 'Sein neuer Diener Passepartout hatte sich eigentlich ein ruhiges Leben gewünscht. Doch schon am selben Abend saßen beide im Zug, denn Fogg wollte keine einzige Stunde verlieren.',
          B2: 'Passepartout, der gerade erst in Foggs Dienst getreten war und auf ein geruhsames Leben gehofft hatte, fand sich noch am selben Abend im Zug wieder. Für seinen Herrn zählte jede Minute, und Verspätungen duldete er nicht.',
        },
      },
      {
        title: 'Eine Rettung in Indien',
        levels: {
          A1: 'In Indien sehen sie eine junge Frau in Gefahr. Fogg hilft ihr. Sie heißt Aouda und reist jetzt mit.',
          A2: 'In Indien retten Fogg und Passepartout eine junge Witwe namens Aouda. Sie ist sehr dankbar und reist von nun an mit den beiden Männern weiter.',
          B1: 'Mitten in Indien gerieten sie in eine gefährliche Lage, als sie die junge Witwe Aouda retteten. Weil sie nirgendwo sicher war, beschloss Fogg, sie mitzunehmen.',
          B2: 'In Indien stießen die Reisenden auf die junge Witwe Aouda, die in höchster Gefahr schwebte. Ohne zu zögern befreiten sie die Frau, und da sie nirgends in Sicherheit war, nahm Fogg sie selbstverständlich unter seinen Schutz.',
        },
      },
      {
        title: 'Der Detektiv Fix',
        levels: {
          A1: 'Ein Detektiv heißt Fix. Er denkt: Fogg ist ein Dieb. Er folgt ihnen überall.',
          A2: 'Ein Detektiv namens Fix glaubt, dass Fogg eine Bank ausgeraubt hat. Darum folgt er ihm heimlich von Stadt zu Stadt.',
          B1: 'Detektiv Fix war überzeugt, dass Fogg ein Bankräuber sei. Deshalb verfolgte er ihn heimlich und versuchte immer wieder, die Reise zu verzögern.',
          B2: 'Der hartnäckige Detektiv Fix hielt Fogg für den gesuchten Bankräuber. Unbemerkt heftete er sich an seine Fersen und schmiedete einen Plan nach dem anderen, um die Weiterreise des Gentlemans aufzuhalten.',
        },
      },
      {
        title: 'Sturm auf dem Ozean',
        levels: {
          A1: 'Auf dem Meer kommt ein Sturm. Das Schiff ist langsam. Fogg hat wenig Zeit.',
          A2: 'Auf dem Atlantik gerät das Schiff in einen Sturm. Der Wind ist stark und das Schiff wird langsamer. Fogg hat fast keine Zeit mehr.',
          B1: 'Über dem Ozean tobte ein heftiger Sturm, der das Schiff aufhielt. Fogg blieb ruhig, obwohl die kostbare Zeit langsam zu Ende ging.',
          B2: 'Als ein gewaltiger Sturm über den Atlantik fegte, drohte die Reise zu scheitern. Doch während die anderen verzweifelten, behielt Fogg die Nerven und kaufte kurzerhand das ganze Schiff, um sein Ziel rechtzeitig zu erreichen.',
        },
      },
      {
        title: 'Zurück in London',
        levels: {
          A1: 'Fogg kommt nach London zurück. Er denkt: Ich habe verloren. Aber er hat einen Tag gewonnen! Er gewinnt die Wette.',
          A2: 'In London glaubt Fogg zuerst, dass er die Wette verloren hat. Doch er hat auf der Reise nach Osten einen ganzen Tag gewonnen. So kommt er doch rechtzeitig an und gewinnt.',
          B1: 'Zurück in London war Fogg sicher, dass er zu spät gekommen war. Erst dann merkte er, dass er durch die Reise nach Osten einen Tag gewonnen hatte – und die Wette doch noch gewann.',
          B2: 'In London angekommen, hielt Fogg sich für den Verlierer der Wette. Was er übersehen hatte: Auf seiner Reise gen Osten war ihm ein voller Tag geschenkt worden. So triumphierte er in letzter Sekunde – und fand obendrein in Aouda das Glück seines Lebens.',
        },
      },
    ],
  },
  {
    id: 'oz',
    title: 'Der Zauberer von Oz',
    subtitle: 'Der Weg aus der Smaragdstadt',
    description: 'Ураган уносит девочку Дороти в волшебную страну Оз, и она ищет дорогу домой по жёлтой кирпичной дороге — а в финале её ждёт воздушный шар.',
    fragments: [
      {
        title: 'Der Wirbelsturm',
        levels: {
          A1: 'Dorothy lebt in Kansas. Ein Wirbelsturm kommt. Er trägt ihr Haus weit weg.',
          A2: 'Dorothy wohnt mit ihrem Hund Toto in Kansas. Eines Tages kommt ein starker Wirbelsturm und trägt ihr kleines Haus hoch in die Luft.',
          B1: 'Dorothy lebte mit ihrem Hund Toto auf einem Bauernhof in Kansas. Als ein gewaltiger Wirbelsturm aufzog, hob er das ganze Haus in die Luft und trug es davon.',
          B2: 'Dorothy führte mit ihrem treuen Hund Toto ein einfaches Leben in der grauen Weite von Kansas. Doch eines Tages riss ein gewaltiger Wirbelsturm das Haus samt Mädchen und Hund empor und schleuderte es in eine völlig fremde Welt.',
        },
      },
      {
        title: 'Das Land Oz',
        levels: {
          A1: 'Das Haus landet im Land Oz. Alles ist bunt. Dorothy folgt der gelben Straße.',
          A2: 'Das Haus landet in einem bunten Land namens Oz. Dorothy will nach Hause und folgt einer Straße aus gelben Steinen.',
          B1: 'Das Haus landete in dem wunderbaren Land Oz, wo alles farbig und fremd war. Um nach Hause zu finden, folgte Dorothy der gelben Ziegelstraße.',
          B2: 'Als das Haus endlich landete, fand sich Dorothy in dem farbenprächtigen Land Oz wieder, das ihr fremder nicht hätte sein können. Man riet ihr, der gelben Ziegelstraße zu folgen, die sie zur geheimnisvollen Smaragdstadt führen sollte.',
        },
      },
      {
        title: 'Drei Freunde',
        levels: {
          A1: 'Dorothy trifft drei Freunde: eine Vogelscheuche, einen Mann aus Blech und einen Löwen.',
          A2: 'Auf dem Weg trifft Dorothy drei Freunde: eine Vogelscheuche ohne Verstand, einen Mann aus Blech ohne Herz und einen Löwen ohne Mut.',
          B1: 'Unterwegs schlossen sich Dorothy drei Gefährten an: eine Vogelscheuche, die sich Verstand wünschte, ein Blechmann, der ein Herz suchte, und ein Löwe, dem der Mut fehlte.',
          B2: 'Auf ihrer langen Wanderung gewann Dorothy drei ungewöhnliche Gefährten: eine Vogelscheuche, die sich nach Verstand sehnte, einen Blechmann, der von einem Herzen träumte, und einen ängstlichen Löwen, der endlich Mut finden wollte.',
        },
      },
      {
        title: 'Die Smaragdstadt',
        levels: {
          A1: 'Endlich sehen sie die grüne Stadt. Dort wohnt der große Zauberer von Oz.',
          A2: 'Am Ende der Straße erreichen sie die grüne Smaragdstadt. Hier wohnt der mächtige Zauberer von Oz, und alle hoffen auf seine Hilfe.',
          B1: 'Schließlich erreichten sie die glänzende Smaragdstadt, in der der mächtige Zauberer von Oz lebte. Jeder hoffte, dass er ihm seinen größten Wunsch erfüllen würde.',
          B2: 'Nach vielen Gefahren erreichten die Gefährten endlich die strahlende Smaragdstadt, wo der allmächtige Zauberer von Oz herrschen sollte. Voller Hoffnung trat jeder vor ihn, überzeugt, dass nur er ihre sehnlichsten Wünsche erfüllen könne.',
        },
      },
      {
        title: 'Das Geheimnis des Zauberers',
        levels: {
          A1: 'Der Zauberer ist gar kein Zauberer. Er ist nur ein alter Mann. Er hat einen großen Ballon.',
          A2: 'Bald entdecken sie ein Geheimnis: Der Zauberer ist gar nicht mächtig. Er ist nur ein alter Mann, der mit einem großen Ballon nach Hause fliegen will.',
          B1: 'Doch hinter einem Vorhang entdeckten sie die Wahrheit: Der Zauberer war gar kein Zauberer, sondern ein einfacher alter Mann. Mit einem großen Ballon wollte er die Stadt verlassen.',
          B2: 'Hinter einem Vorhang kam die überraschende Wahrheit ans Licht: Der gefürchtete Zauberer war nichts als ein gewöhnlicher alter Mann, den man einst selbst mit einem Ballon nach Oz verschlagen hatte. Nun rüstete er denselben Ballon, um endlich in seine Heimat zurückzukehren.',
        },
      },
      {
        title: 'Nach Hause',
        levels: {
          A1: 'Dorothy hat magische Schuhe. Sie schlägt die Schuhe zusammen und sagt: nach Hause! So kommt sie zurück nach Kansas.',
          A2: 'Am Ende helfen Dorothy ihre magischen Schuhe. Sie schlägt die Hacken dreimal zusammen, wünscht sich ihr Zuhause – und ist plötzlich wieder in Kansas.',
          B1: 'Am Ende erfuhr Dorothy, dass ihre silbernen Schuhe Zauberkraft besaßen. Sie schlug die Hacken dreimal zusammen, dachte fest an ihr Zuhause und stand im nächsten Augenblick wieder in Kansas.',
          B2: 'Schließlich offenbarte sich Dorothy das letzte Geheimnis: Ihre silbernen Schuhe hatten die ganze Zeit die Macht besessen, sie heimzubringen. Sie schlug die Hacken dreimal zusammen, dachte voller Sehnsucht an Kansas – und kehrte im selben Augenblick zu denen zurück, die sie liebte.',
        },
      },
    ],
  },
  {
    id: 'treasure',
    title: 'Die Schatzinsel',
    subtitle: 'Eine Karte und ein Geheimnis',
    description: 'Юнга Джим Хокинс находит карту сокровищ и отправляется на корабле к далёкому острову, где его ждут пираты, золото и предатель среди команды.',
    fragments: [
      {
        title: 'Die alte Seekarte',
        levels: {
          A1: 'Jim ist ein junger Junge. Er findet eine alte Karte. Auf der Karte ist ein Schatz.',
          A2: 'Der junge Jim findet in einer alten Kiste eine geheimnisvolle Karte. Auf ihr sind eine Insel und ein Kreuz: Dort liegt ein Schatz.',
          B1: 'Der junge Jim Hawkins entdeckte in der Truhe eines toten Seemanns eine alte Karte. Sie zeigte eine ferne Insel, und ein rotes Kreuz markierte einen verborgenen Schatz.',
          B2: 'In der Truhe eines verstorbenen Kapitäns stieß der junge Jim Hawkins auf eine vergilbte Seekarte. Sie zeigte eine entlegene Insel, auf der ein rotes Kreuz den Ort eines sagenhaften Piratenschatzes verriet.',
        },
      },
      {
        title: 'An Bord der Hispaniola',
        levels: {
          A1: 'Jim segelt mit einem Schiff. Das Schiff heißt Hispaniola. Der Koch heißt Long John Silver.',
          A2: 'Jim segelt mit dem Schiff Hispaniola zur Insel. Der freundliche Koch mit nur einem Bein heißt Long John Silver.',
          B1: 'Bald segelte Jim auf der Hispaniola hinaus aufs Meer. Der Schiffskoch, ein freundlicher Mann mit nur einem Bein, hieß Long John Silver.',
          B2: 'Schon wenige Wochen später stach Jim an Bord der Hispaniola in See. Besonders gut verstand er sich mit dem einbeinigen Schiffskoch Long John Silver, dessen einnehmende Art jedoch trog.',
        },
      },
      {
        title: 'Das Gespräch im Apfelfass',
        levels: {
          A1: 'Jim sitzt in einem Fass. Er hört die Männer. Sie sind Piraten!',
          A2: 'Eines Abends versteckt sich Jim in einem Apfelfass. Dort hört er ein Geheimnis: Silver und seine Männer sind Piraten und planen einen Verrat.',
          B1: 'Eines Nachts kletterte Jim in ein Apfelfass und hörte zufällig ein Gespräch. So erfuhr er, dass Silver und seine Männer in Wahrheit Piraten waren, die eine Meuterei planten.',
          B2: 'Als Jim sich eines Abends in einem Apfelfass versteckte, belauschte er ein verhängnisvolles Gespräch. Mit Entsetzen begriff er, dass der freundliche Silver und ein Großteil der Mannschaft Piraten waren, die nur auf den richtigen Moment für ihre Meuterei warteten.',
        },
      },
      {
        title: 'Land in Sicht',
        levels: {
          A1: 'Endlich sehen sie Land. Es ist die Insel. Alle sind nervös.',
          A2: 'Nach vielen Tagen rufen die Matrosen: Land! Vor ihnen liegt die Insel mit dem Schatz, doch die Stimmung an Bord ist gefährlich.',
          B1: 'Nach langer Fahrt tauchte endlich die Insel am Horizont auf. Die Spannung an Bord wuchs, denn jeder wusste nun, dass bald ein Kampf um den Schatz beginnen würde.',
          B2: 'Nach wochenlanger Fahrt erhob sich die geheimnisvolle Insel endlich aus dem Meer. Die Luft an Bord war zum Zerreißen gespannt, denn beide Seiten ahnten, dass der Kampf um das Gold unmittelbar bevorstand.',
        },
      },
      {
        title: 'Ben Gunn',
        levels: {
          A1: 'Auf der Insel lebt ein Mann allein. Er heißt Ben Gunn. Er kennt das Gold.',
          A2: 'Auf der Insel trifft Jim einen einsamen Mann namens Ben Gunn. Er lebt schon lange allein hier und kennt das Geheimnis des Goldes.',
          B1: 'Auf der Insel begegnete Jim einem seltsamen Mann namens Ben Gunn, der seit Jahren allein dort lebte. Er hatte den Schatz längst gefunden und an einen sicheren Ort gebracht.',
          B2: 'Auf der Insel stieß Jim auf den wunderlichen Ben Gunn, der nach Jahren der Einsamkeit halb verwildert war. Wie sich herausstellte, hatte gerade dieser vergessene Mann den Schatz längst entdeckt und heimlich in ein neues Versteck geschafft.',
        },
      },
      {
        title: 'Das Gold und die Heimfahrt',
        levels: {
          A1: 'Am Ende finden sie das Gold. Jim fährt nach Hause. Er ist jetzt reich.',
          A2: 'Am Ende gewinnen die ehrlichen Männer den Kampf und finden das Gold. Jim segelt nach Hause und ist endlich reich und in Sicherheit.',
          B1: 'Schließlich besiegten die ehrlichen Männer die Piraten und bargen das Gold. Jim kehrte wohlbehalten nach Hause zurück, reicher und um viele Abenteuer klüger.',
          B2: 'Am Ende setzten sich die ehrlichen Männer gegen die Piraten durch und brachten den sagenhaften Schatz an Bord. Jim kehrte wohlbehalten in die Heimat zurück – nicht nur reich an Gold, sondern auch an Erinnerungen, die ihn sein Leben lang begleiten sollten.',
        },
      },
    ],
  },
];
let player = null, propeller = null, airship = null, gun = null, gunBarrel = null;
let gunBarrelAimAxis = V3(0, 0, -1);
// Fixed orientation that brings the barrel's measured axis to point straight
// forward at neutral aim; the live cone rotation is composed onto this so the
// barrel (and its ring sight) rotates by exactly the same yaw/pitch as the camera.
const gunBarrelRestQuat = new T.Quaternion();
let enemyTpl = null;       // template gltf scene for cloning
const enemies = [];
const flight = { pos: V3(0, 6, 16), yaw: Math.PI, pitch: 0, roll: 0, speed: 11.5 };
// In gun mode the plane keeps flying (auto-patrol around the airship); you can't
// steer it, only aim the gun within a ±45° cone of its nose.
const GUN_CRUISE = 6.8;
let shake = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function storyById(id) {
  return AIRSHIP_STORIES.find(story => story.id === id) || AIRSHIP_STORIES[0];
}

function readSelectedStoryId() {
  try {
    return storyById(localStorage.getItem(STORY_SELECTED_KEY)).id;
  } catch (_) {
    return AIRSHIP_STORIES[0].id;
  }
}

function saveSelectedStoryId(id) {
  const story = storyById(id);
  try { localStorage.setItem(STORY_SELECTED_KEY, story.id); } catch (_) {}
  return story;
}

function storyProgressKey(story) {
  return STORY_PROGRESS_PREFIX + story.id;
}

function readStoryIndex(story = storyById(readSelectedStoryId())) {
  try {
    const n = Number(localStorage.getItem(storyProgressKey(story)));
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  } catch (_) {
    return 0;
  }
}

function nextStoryFragment() {
  const story = storyById(readSelectedStoryId());
  const index = readStoryIndex(story);
  const fragment = story.fragments[index % story.fragments.length];
  try { localStorage.setItem(storyProgressKey(story), String(index + 1)); } catch (_) {}
  renderStoryChoice();
  return { story, fragment, number: (index % story.fragments.length) + 1, total: story.fragments.length };
}

function renderStoryChoice() {
  if (!ui.storyChoice) return;
  const selectedId = readSelectedStoryId();
  const story = storyById(selectedId);
  const progress = readStoryIndex(story);
  const nextNumber = (progress % story.fragments.length) + 1;
  const opened = Math.min(progress, story.fragments.length);
  ui.storyChoice.innerHTML = `
    <div class="story-head">
      <div>
        <div class="story-kicker">История</div>
        <div class="story-name">${escapeHtml(story.title)}</div>
      </div>
      <div class="story-progress">${opened}/${story.fragments.length}</div>
    </div>
    <label>
      <span>Сюжетная линия</span>
      <select id="storySelect">
        ${AIRSHIP_STORIES.map(item => `<option value="${escapeHtml(item.id)}"${item.id === selectedId ? ' selected' : ''}>${escapeHtml(item.title)}</option>`).join('')}
      </select>
    </label>
    <p>${escapeHtml(story.description)}</p>
    <div class="story-next">${escapeHtml(story.subtitle)} · следующий фрагмент ${nextNumber}/${story.fragments.length}</div>
  `;
  ui.storyChoice.querySelector('#storySelect')?.addEventListener('change', event => {
    saveSelectedStoryId(event.target.value);
    renderStoryChoice();
  });
}

// Stories are graded readers: each fragment carries one German text per CEFR
// level. Pick the variant for the player's selected level, with sensible
// fallbacks (and the legacy single-text shape) so nothing ever renders blank.
const STORY_LEVELS = ['A1', 'A2', 'B1', 'B2'];
function fragmentText(fragment, level) {
  const lv = fragment.levels;
  if (lv) return lv[level] || lv.A2 || lv[STORY_LEVELS.find(l => lv[l])] || '';
  return fragment.text || '';
}

function showVictoryStory() {
  if (!ui.storyCard) return;
  const { story, fragment, number, total } = nextStoryFragment();
  const level = window.getSeaQuizSettings?.().level || 'A2';
  ui.storyCard.innerHTML = `
    <div class="story-kicker">${escapeHtml(story.title)} · фрагмент ${number}/${total} · ${escapeHtml(level)}</div>
    <b>${escapeHtml(fragment.title)}</b>
    <p>${escapeHtml(fragmentText(fragment, level))}</p>
  `;
  ui.storyCard.classList.remove('hidden');
}

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
  airshipHalf.copy(an.dim).multiplyScalar(0.5); // collision ellipsoid half-extents
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
  gun = gn.pivot; enableShadows(gun, true, false); scene.add(gun);
  // Split the model: the "machine gun" (barrel) swivels; the frame/ring it sits
  // on stays put. Re-parent the barrel mesh onto a pivot at its own centre so
  // rotating the pivot swivels just the gun.
  gun.updateMatrixWorld(true);
  let barrelMesh = null, barrelScore = -Infinity;
  gun.traverse(n => {
    if (!n.isMesh) return;
    const name = String(n.name || '');
    const score =
      (/barrel|ствол|дул/i.test(name) ? 100 : 0) +
      (/machine\s*gun|gun|пулем/i.test(name) ? 20 : 0) -
      (/frame|ring|mount|base|рама|кольц|стан/i.test(name) ? 35 : 0);
    if (score > barrelScore) { barrelScore = score; barrelMesh = n; }
  });
  if (barrelMesh) {
    // Put the barrel under a local swivel pivot inside the fixed gun frame.
    // The frame follows the plane; this pivot receives the same local yaw/pitch
    // as the reticle, so only the barrel moves.
    const box = new T.Box3().setFromObject(barrelMesh), c = new T.Vector3(); box.getCenter(c);
    gunBarrel = new T.Group();
    gunBarrel.name = 'GunBarrelSwivel';
    gunBarrel.position.copy(gun.worldToLocal(c.clone()));
    gun.add(gunBarrel);
    gun.updateWorldMatrix(true, true);
    gunBarrel.updateWorldMatrix(true, false);
    gunBarrel.attach(barrelMesh); // world-preserving; barrel now centred on the pivot
    const geom = barrelMesh.geometry;
    if (geom) {
      geom.computeBoundingBox();
      const bb = geom.boundingBox;
      if (bb) {
        const size = new T.Vector3(); bb.getSize(size);
        const mid = new T.Vector3(); bb.getCenter(mid);
        const axis = size.x > size.y && size.x > size.z ? 'x' : (size.y > size.z ? 'y' : 'z');
        const a = mid.clone(), b = mid.clone();
        a[axis] = bb.min[axis]; b[axis] = bb.max[axis];
        gun.updateWorldMatrix(true, true);
        gunBarrel.updateWorldMatrix(true, true);
        barrelMesh.updateWorldMatrix(true, false);
        const aw = barrelMesh.localToWorld(a.clone());
        const bw = barrelMesh.localToWorld(b.clone());
        const ag = gun.worldToLocal(aw.clone());
        const bg = gun.worldToLocal(bw.clone());
        const frontW = ag.z <= bg.z ? aw : bw;
        const backW = ag.z <= bg.z ? bw : aw;
        const frontL = gunBarrel.worldToLocal(frontW.clone());
        const backL = gunBarrel.worldToLocal(backW.clone());
        const measured = frontL.sub(backL);
        if (measured.lengthSq() > 1e-6) gunBarrelAimAxis.copy(measured.normalize());
      }
    }
    // rest orientation: measured barrel axis -> local forward. The per-frame cone
    // rotation is multiplied onto this (see updateGunCamera) so the barrel turns
    // rigidly with the reticle.
    gunBarrelRestQuat.setFromUnitVectors(gunBarrelAimAxis, V3(0, 0, -1));
  }
  gun.visible = false; if (gunBarrel) gunBarrel.visible = false;
  tick();

  // enemy template
  ui.loadMsg.textContent = 'Подъём эскадрильи…';
  const eg = await loadGLB('enemy_ww1.glb');
  enemyTpl = eg.scene;

  // ground haze plane (subtle, for reference + shadow catch far below)
  const groundMat = new T.MeshStandardMaterial({ color: 0x3a4a5e, roughness: 1, metalness: 0, transparent: true, opacity: .5 });
  const ground = new T.Mesh(new T.PlaneGeometry(2000, 2000), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = CFG.FLOOR; ground.receiveShadow = true; scene.add(ground);

  scene.fog = new T.FogExp2(0x9fb6cf, 0.0016);

  renderStoryChoice();
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
  // spawn out on a ring around the airship, heading inbound
  const ang = rnd(0, Math.PI * 2), R = rnd(75, 110);
  const sp = airship.position.clone().add(V3(Math.cos(ang) * R, rnd(-4, 16), Math.sin(ang) * R));
  obj.position.copy(sp);
  faceForward(obj, airship.position); // nose inbound from the start
  scene.add(obj);
  const e = {
    obj, hp: CFG.ENEMY_HP, state: 'approach', speed: rnd(CFG.ENEMY_SPEED[0], CFG.ENEMY_SPEED[1]),
    fireT: rnd(.5, 1.4), pursuer: Math.random() < 0.5, passes: 0, roll: 0, alive: true, target: 'ship',
    smokeT: rnd(0, .2), orbit: Math.random() < 0.5 ? -1 : 1,
  };
  enemies.push(e);
  if (G.running && !G.over) G.spawned++;
}
function chaserCount() { let n = 0; for (const e of enemies) if (e.alive && e.state === 'chase') n++; return n; }
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

function damageSmokeLevel(hp, maxHp) {
  const r = hp / maxHp;
  if (r <= 0.25) return 3;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 1;
  return 0;
}

function emitDamageSmoke(obj, level) {
  if (!obj || level <= 0) return;
  const back = V3(0, 0.15, 0.8 + level * 0.18).applyQuaternion(obj.quaternion);
  const pos = obj.position.clone().add(back).add(randDir().multiplyScalar(0.15 + level * 0.08));
  const vel = V3(0, 0.25 + level * 0.08, 0.35 + level * 0.2).applyQuaternion(obj.quaternion)
    .add(randDir().multiplyScalar(0.18 * level));
  spawn({
    map: TEX.smoke, blend: T.NormalBlending, pos, vel,
    s0: 0.16 + level * 0.12, s1: 0.7 + level * 0.65, life: 0.8 + level * 0.45,
    grav: 0.2, drag: 1.1, rot0: Math.random() * 6, rot: rnd(-0.8, 0.8),
    grad: level >= 3 ? GR.smoke : GR.msmoke, op: opSmoke, bright: 0.28 + level * 0.13,
  });
  if (level >= 3 && Math.random() < 0.38) {
    spawn({ map: TEX.spark, blend: T.AdditiveBlending, pos: pos.clone(), vel: randDir().multiplyScalar(rnd(.5, 1.8)), s0: rnd(.04, .08), s1: .02, life: rnd(.22, .45), grav: -2, drag: 1, grad: GR.ember, op: opEmber, bright: .9 });
  }
}

function updateEnemyDamageSmoke(e, dt) {
  const level = damageSmokeLevel(e.hp, CFG.ENEMY_HP);
  if (!level) return;
  e.smokeT -= dt;
  const every = level === 1 ? 0.22 : level === 2 ? 0.12 : 0.065;
  if (e.smokeT <= 0) {
    e.smokeT = every;
    emitDamageSmoke(e.obj, level);
  }
}

function updatePlayerDamageSmoke(dt) {
  if (!player || !G.running || G.over) return;
  const level = damageSmokeLevel(G.meHp, CFG.PLAYER_HP);
  if (!level) return;
  G.playerSmokeT -= dt;
  const every = level === 1 ? 0.2 : level === 2 ? 0.1 : 0.055;
  if (G.playerSmokeT <= 0) {
    G.playerSmokeT = every;
    emitDamageSmoke(player, level);
  }
}

function updateEnemies(dt) {
  ui.enemyCount.textContent = enemies.length;
  const ship = airship.position;
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i]; if (!e.alive) continue;
    const obj = e.obj;
    const distShip = obj.position.distanceTo(ship);
    updateEnemyDamageSmoke(e, dt);

    if (e.state === 'chase') {
      // pursuer that broke off: hunt the player and shoot at them
      const toPlayer = player.position.clone().sub(obj.position);
      const d = toPlayer.length();
      const playerDir = d > 1e-4 ? toPlayer.clone().multiplyScalar(1 / d) : V3(0, 0, -1);
      const lateral = playerDir.clone().cross(_up).multiplyScalar(e.orbit || 1);
      let desired;
      if (d < CFG.CHASER_STANDOFF) {
        desired = playerDir.clone().negate().add(lateral.multiplyScalar(0.55)).normalize();
      } else if (d < CFG.CHASER_STANDOFF + 18) {
        desired = lateral.add(playerDir.multiplyScalar(0.18)).normalize();
      } else {
        desired = playerDir;
      }
      flyToward(e, desired, dt, d < CFG.CHASER_STANDOFF + 18 ? 1.45 : 1.0);
      e.fireT -= dt;
      const near = clamp(1 - d / 110, 0, 1);
      if (e.fireT <= 0 && d < 110) { e.fireT = lerp(2.2, 0.85, near); e.target = 'player'; enemyFire(e, player.position, near); }
    } else if (e.state === 'approach') {
      // run in on the airship, firing more accurately the closer we get
      const desired = ship.clone().sub(obj.position).normalize();
      flyToward(e, desired, dt, 0.9);
      e.fireT -= dt;
      const near = clamp(1 - distShip / 100, 0, 1);
      if (e.fireT <= 0 && distShip < 100) { e.fireT = lerp(1.55, 0.48, near); e.target = 'ship'; enemyFire(e, ship, near); }
      if (distShip < 24) e.state = 'pass';
    } else if (e.state === 'pass') {
      // punch straight through, past the airship
      _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
      e.roll = lerp(e.roll, 0, clamp(4 * dt, 0, 1));
      // keep current heading (no steer) — just fly forward
      obj.position.addScaledVector(_fwd, e.speed * dt);
      if (distShip > 50) {
        e.passes++;
        // only let a couple peel off to chase you; the rest loop back on the airship
        e.state = (e.pursuer && e.passes >= 1 && chaserCount() < CFG.MAX_PURSUERS) ? 'chase' : 'turn';
      }
    } else if (e.state === 'turn') {
      // out beyond the airship: bank around and come back for another run
      const desired = ship.clone().sub(obj.position).normalize();
      flyToward(e, desired, dt, 1.3);
      _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
      if (_fwd.dot(desired) > 0.75) e.state = 'approach'; // pointing back at the airship
    }

    if (obj.position.y < CFG.FLOOR + 8) obj.position.y = CFG.FLOOR + 8;
    if (obj.position.y > 80) obj.position.y = 80;
    // if a chaser/turner wanders too far, fold it back into an approach
    if (distShip > 260) { faceForward(obj, ship); e.state = "approach"; }
  }
}

function enemyFire(e, targetPos, near) {
  const muzzle = e.obj.position.clone().add(V3(0, 0, -1).applyQuaternion(e.obj.quaternion).multiplyScalar(CFG.ENEMY.size * .6));
  const intendedTarget = targetPos.clone();
  const targetKind = e.target;
  const aimPoint = targetPos.clone();
  if (targetKind === 'ship') {
    // tight scatter so the tracer visibly lands ON the hull — every shot that
    // reaches the airship counts; how much HP it removes is governed by the
    // session damage budget (shipDamageCap), not by a per-shot dice roll.
    aimPoint.add(V3(rnd(-4, 4), rnd(-2.4, 2.4), rnd(-4, 4)));
  }
  const aimVector = aimPoint.clone().sub(muzzle);
  const dir = aimVector.clone().normalize();
  if (targetKind === 'player') {
    dir.x += rnd(-1, 1) * .03; dir.y += rnd(-1, 1) * .03; dir.normalize();
  }
  const dist = aimVector.length() + (targetKind === 'ship' ? 4 : 6);
  spawnTracer(muzzle, dir, dist, false, (impactPoint) => {
    if (G.over) return;
    if (targetKind === 'player') {
      const movementMiss = clamp(1 - player.position.distanceTo(intendedTarget) / 18, 0.15, 1);
      const evasionPenalty = clamp(1 - G.evasion * 0.68, 0.25, 1);
      if (Math.random() < near * 0.4 * movementMiss * evasionPenalty) damagePlayer(Math.round(rnd(2, 5)));
    } else {
      // a hull hit ALWAYS bites — the airship's prochnost' drops on contact.
      applyShipHit(Math.round(rnd(3, 6) + near * 2), impactPoint);
    }
  });
  muzzleFlash(muzzle, dir);
}

/* ============================ DAMAGE / DEATH ====================== */
// Per-session difficulty ramp. The first run of a session is forgiving so a new
// player can find their feet; by the third run the full 140% / 41% balance is on.
function difficulty() {
  const g = G.gameIndex;
  if (g <= 0) return { budget: 1.10, surviveKill: 0.22 }; // 1st run: gentle
  if (g === 1) return { budget: 1.25, surviveKill: 0.32 }; // 2nd run: ramping up
  return { budget: CFG.SHIP_DMG_BUDGET, surviveKill: CFG.SHIP_SURVIVE_KILL }; // 3rd+: full
}
// The most damage the wave is allowed to have inflicted on the hull SO FAR.
// frac(killRatio) is a line: budget×HP at 0 kills, exactly HP at the survive
// threshold, so falling below the threshold lets total damage exceed the hull
// (loss) while clearing it keeps the airship alive. Eased in over the round so
// the airship is never deleted in the opening seconds.
function shipDamageCap() {
  const ratio = G.kills / Math.max(1, G.spawned);
  const d = difficulty();
  const slope = (d.budget - 1) / d.surviveKill;            // crosses 1.0 at surviveKill
  const frac = clamp(d.budget - slope * ratio, 0, d.budget);
  const timeProg = clamp((CFG.ROUND_TIME - G.timeLeft) / CFG.ROUND_TIME, 0, 1);
  const pacing = 0.12 + 0.88 * timeProg;                   // spread the budget across the round
  return CFG.SHIP_HP * frac * pacing;
}
function applyShipHit(raw, at) {
  if (G.over) return;
  const dealt = CFG.SHIP_HP - G.shipHp;
  const room = shipDamageCap() - dealt;                    // budget not yet spent
  if (room < 0.5) return;                                  // defending well: wave is held off for now
  damageShip(Math.max(1, Math.round(Math.min(raw, room))), at);
}
function damageShip(d, at) {
  if (G.over) return;
  G.shipHp = Math.max(0, G.shipHp - d);
  setShipHp();
  impact((at || airship.position).clone().add(randDir().multiplyScalar(3)).setY(airship.position.y + rnd(-3, 3)), V3(0, 1, 0), 1.1);
  if (G.shipHp <= 0) cinematicLoss('ship', 'Дирижабль уничтожен.');
}
function damagePlayer(d) {
  if (G.over) return;
  G.meHp = Math.max(0, G.meHp - d); setMeHp();
  ui.dmg.style.opacity = clamp(d / 8, .3, 1); setTimeout(() => ui.dmg.style.opacity = 0, 120);
  shake = Math.min(1.4, shake + .25);
  if (G.meHp <= 0) cinematicLoss('player', 'Твой борт сбит.');
}
function killEnemy(e, at) {
  e.alive = false;
  const c = e.obj.position.clone();
  bigBoom(c, 1.25);
  const baseVel = V3(0, 0, -1).applyQuaternion(e.obj.quaternion).multiplyScalar(e.speed * .5);
  // re-resolve the live mesh under the placed pivot and Voronoi-fracture it
  let live = null; e.obj.traverse(n => { if (n.isMesh && (!live || n.geometry.attributes.position.count > live.geometry.attributes.position.count)) live = n; });
  if (live) { try { fractureMesh(live, c, baseVel, 9, 0x7a6a4a); } catch (err) { console.warn('fracture failed', err); } }
  scene.remove(e.obj);
  const idx = enemies.indexOf(e); if (idx >= 0) enemies.splice(idx, 1);
  G.kills++; ui.kills.textContent = G.kills;
}

function explodeLargestMesh(root, center, baseVel, fragments, tint) {
  if (!root) return;
  let live = null;
  root.traverse(n => { if (n.isMesh && n.geometry?.attributes?.position && (!live || n.geometry.attributes.position.count > live.geometry.attributes.position.count)) live = n; });
  bigBoom(center, root === airship ? 2.3 : 1.6);
  if (live) {
    try { fractureMesh(live, center, baseVel || V3(), fragments, tint); }
    catch (err) { console.warn('large fracture failed', err); }
  }
  root.visible = false;
}

function cinematicLoss(kind, msg) {
  if (G.over) return;
  G.over = true; G.running = false; firing = false;
  renderer.domElement.style.cursor = 'default'; if (pointerLocked) document.exitPointerLock();
  const target = (kind === 'ship' ? airship : player).position.clone();
  if (kind === 'ship') explodeLargestMesh(airship, target, V3(0, 0, 0), 22, 0xa08c62);
  else {
    const baseVel = V3(0, 0, -1).applyQuaternion(player.quaternion).multiplyScalar(Math.max(8, flight.speed));
    explodeLargestMesh(player, target, baseVel, 12, 0x2f6bd8);
    if (gun) gun.visible = false;
    if (gunBarrel) gunBarrel.visible = false;
  }
  shake = Math.max(shake, 1.4);
  G.cinematic = { target, t: 0, kind };
  setTimeout(() => showEndOverlay(false, msg), 2700);
}

/* ============================ SHOOTING ============================ */
const ray = new T.Raycaster();
let firing = false, cooldown = 0; const FIRE_DT = 0.08;
let recoil = 0;
function fire() {
  if (G.ammo <= 0) { return; }
  // shots follow the aim; muzzle sits just under the view, where the barrel points
  const aimDir = V3(0, 0, -1).applyQuaternion(camera.quaternion);
  const muzzle = gunBarrel
    ? gunBarrel.getWorldPosition(new T.Vector3()).addScaledVector(aimDir, 0.75)
    : camera.position.clone().addScaledVector(aimDir, 1.6).addScaledVector(V3(0, -1, 0).applyQuaternion(camera.quaternion), 0.35);
  const dir = aimDir.clone();
  dir.x += rnd(-1, 1) * .006; dir.y += rnd(-1, 1) * .006; dir.normalize();

  // Raycast from the CAMERA (the crosshair line), not the offset muzzle — otherwise
  // the parallel-shifted ray can slip past a small enemy that's on the crosshair.
  ray.set(camera.position, dir); ray.far = 400;
  let hitE = null, hitInfo = null;
  for (const e of enemies) {
    if (!e.alive) continue;
    const hs = ray.intersectObject(e.obj, true);
    if (hs.length) { if (!hitInfo || hs[0].distance < hitInfo.distance) { hitInfo = hs[0]; hitE = e; } }
  }
  let hitPoint = null;
  if (hitInfo) { hitPoint = hitInfo.point.clone(); }
  else {
    // forgiving fallback: if the crosshair sits within an enemy's angular radius,
    // count it as a hit (covers thin/low-poly geometry the thin ray misses)
    let best = Infinity;
    for (const e of enemies) {
      if (!e.alive) continue;
      const to = e.obj.position.clone().sub(camera.position); const d = to.length(); to.multiplyScalar(1 / d);
      const ang = to.angleTo(dir), angR = Math.atan2(CFG.ENEMY.size * 0.55, d) * 1.25;
      if (ang < angR && d < best) { best = d; hitE = e; hitPoint = camera.position.clone().addScaledVector(dir, d); }
    }
  }
  const tracerDir = hitPoint ? hitPoint.clone().sub(muzzle).normalize() : dir;
  const dist = hitPoint ? muzzle.distanceTo(hitPoint) : 300;
  spawnTracer(muzzle, tracerDir, dist, true, hitE && hitPoint ? (impactPoint) => {
    if (!hitE.alive || G.over) return;
    impact(impactPoint, tracerDir.clone().negate(), 1);
    const v = impactPoint.clone().project(camera);
    popHM((v.x * .5 + .5) * innerWidth, (-v.y * .5 + .5) * innerHeight);
    hitE.hp -= Math.round(rnd(8, 14));
    if (hitE.hp <= 0) killEnemy(hitE, impactPoint);
  } : null);
  muzzleFlash(muzzle, tracerDir);
  muzzleLight.position.copy(muzzle); muzzleLightI = 2.6;
  recoil = Math.min(1.4, recoil + 1); shake = Math.min(1.0, shake + .04);
  G.ammo--; setAmmo();
}

/* ============================ INPUT ============================== */
const keys = {};
addEventListener('keydown', e => {
  keys[e.code] = true;
  if (e.code === 'Tab') { e.preventDefault(); if (!e.repeat) requestToggleMode(); }
  if (e.code === 'KeyR') { e.preventDefault(); if (!e.repeat) requestReload(); }
});
addEventListener('keyup', e => { keys[e.code] = false; });
// debug helpers (only with ?debug) — verify Voronoi+Rapier death without aiming
if (location.search.includes('debug')) {
  window.__spawnClose = () => { makeEnemy(); const e = enemies[enemies.length - 1]; const f = V3(0, 0, -1).applyQuaternion(player.quaternion); e.obj.position.copy(player.position).addScaledVector(f, 30).add(V3(rnd(-6, 6), rnd(2, 8), 0)); e.pursuer = false; return e; };
  window.__killAll = () => { for (const e of enemies.slice()) if (e.alive) killEnemy(e, e.obj.position.clone()); };
  window.__state = () => ({ mode: G.mode, player: player.position.toArray().map(x => +x.toFixed(1)), cam: camera.position.toArray().map(x => +x.toFixed(1)), enemies: enemies.map(e => ({ s: e.state, p: e.obj.position.toArray().map(x => +x.toFixed(1)) })) });
  window.__collNorm = () => { const l = player.position.clone().sub(airship.position); return Math.sqrt((l.x / (airshipHalf.x + PLAYER_R)) ** 2 + (l.y / (airshipHalf.y + PLAYER_R)) ** 2 + (l.z / (airshipHalf.z + PLAYER_R)) ** 2); };
  window.__ramAirship = () => player.position.copy(airship.position);
  window.__spawnOnAim = (d = 40) => { makeEnemy(); const e = enemies[enemies.length - 1]; const f = V3(0, 0, -1).applyQuaternion(camera.quaternion); e.obj.position.copy(camera.position).addScaledVector(f, d); e.pursuer = false; return e; };
  window.__fire = () => fire();
  window.__aim = () => ({yaw:+G.yaw.toFixed(3), pitch:+G.pitch.toFixed(3), locked: typeof pointerLocked!=="undefined"?pointerLocked:null});
}
addEventListener('blur', () => { firing = false; for (const k in keys) keys[k] = false; });

// Pointer-lock aiming: click (LMB) on the scene hides the cursor and aims the gun
// with relative mouse movement (no edge-clamping, so it never "sticks"); Escape
// releases the cursor again so you can use the HUD buttons.
let pointerLocked = false;
const _canvas = renderer.domElement;
_canvas.addEventListener('pointerdown', () => {
  if (!G.running || G.mode !== 'gun' || G.quizActive) return;
  if (!pointerLocked) { _canvas.requestPointerLock(); } // first click: grab the cursor
  firing = true;                                        // and start firing
});
addEventListener('pointerup', () => { firing = false; });
document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === _canvas;
  if (!pointerLocked) firing = false; // Escape released the cursor — stop shooting
});
addEventListener('mousemove', e => {
  if (G.mode === 'gun' && pointerLocked && !G.quizActive) {
    G.yaw = clamp(G.yaw - e.movementX * CFG.AIM_SENS, -CFG.AIM_CONE, CFG.AIM_CONE);
    G.pitch = clamp(G.pitch - e.movementY * CFG.AIM_SENS, -CFG.AIM_CONE, CFG.AIM_CONE);
  }
});

ui.modeBtn.onclick = requestToggleMode;
ui.reloadBtn.onclick = requestReload;
ui.startBtn.onclick = startGame;
// Restart straight into a new round instead of reloading the page (which threw
// the player back out to the start menu and reset their session difficulty).
ui.againBtn.onclick = () => { ui.end.classList.add('hidden'); startGame(); };

async function requestAction(action, context, apply) {
  if (!G.running || G.over || G.actionPending || actionQuiz.active) return;
  G.actionPending = true;
  G.quizPausesCombat = !(action === 'reload' || (action === 'mode' && context.mode === 'flight'));
  firing = false;
  try {
    const correct = await actionQuiz.request(action, context);
    if (correct) apply();
  } catch (error) {
    console.warn('Action quiz failed:', error);
  } finally {
    G.actionPending = false;
    G.quizPausesCombat = false;
  }
}

function requestToggleMode() {
  requestAction('mode', { mode: G.mode === 'gun' ? 'flight' : 'gun' }, toggleMode);
}

function requestReload() {
  if (!G.running || G.over) return;
  requestAction('reload', { ammo: G.ammo }, reload);
}

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
    ? '<kbd>ЛКМ</kbd> навести и огонь · <kbd>мышь</kbd> наводка ±45° · <kbd>Esc</kbd> вернуть курсор · <kbd>R</kbd> перезарядка · <kbd>TAB</kbd> полёт'
    : '<kbd>W/S</kbd> тангаж · <kbd>A/D</kbd> крен · <kbd>Q/E</kbd> рыскание · <kbd>Shift/Ctrl</kbd> газ · <kbd>TAB</kbd> к пулемёту';
  renderer.domElement.style.cursor = 'default'; // pointer-lock hides it while aiming
  if (!gunMode && pointerLocked) document.exitPointerLock();
  gun.visible = gunMode;
  if (gunBarrel) gunBarrel.visible = gunMode;
  if (gunMode) {
    // keep flying from the current pose; you just take the gun
    G.yaw = 0; G.pitch = 0;
    player._roll = player._roll || 0;
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
const _gunEye = new T.Vector3(), _aimDir = new T.Vector3(), _barrelAimQ = new T.Quaternion();
// Auto-pilot: the plane flies DEAD STRAIGHT ahead (you can't steer it, it never
// auto-turns toward the airship). Use flight mode to reposition.
function updateGunFlight(dt) {
  const obj = player;
  player._roll = 0; // keep level — no banking, no inversion
  _fwd.set(0, 0, -1).applyQuaternion(obj.quaternion);
  obj.position.addScaledVector(_fwd, GUN_CRUISE * dt);
  obj.position.y = clamp(obj.position.y, CFG.FLOOR + 6, 80);
  resolvePlayerCollisions();
  G.evasion = Math.max(0, G.evasion - dt * 0.9);
}
function updateGunCamera(dt) {
  // You ride in the cockpit of the moving plane and man the gun. The frame/ring
  // is bolted to the plane; only the barrel + your view swivel within the ±45° cone.
  const base = player.quaternion;
  _coneE.set(G.pitch, G.yaw, 0, 'YXZ'); _coneQ.setFromEuler(_coneE);
  _aimQ.copy(base).multiply(_coneQ);                 // aim = nose heading + cone offset

  // the gun frame/ring is fixed to the plane, in front of the cockpit
  gun.position.copy(player.position).add(V3(0, 0.5, -0.7).applyQuaternion(base));
  gun.quaternion.copy(base);
  // ONLY the barrel swivels inside the fixed frame. Its measured mesh axis is
  // aligned to the exact same local direction as the reticle.
  if (gunBarrel) {
    // Apply the SAME cone rotation the camera/reticle uses (coneQ), composed onto
    // the barrel's fixed rest orientation. This is a rigid rotation about the
    // pivot, so the model's ring sight stays locked on the reticle at every
    // yaw/pitch — unlike a minimal axis-to-axis rotation, which skews off-axis
    // features (the ring) the further you aim, horizontally and vertically.
    _barrelAimQ.copy(_coneQ).multiply(gunBarrelRestQuat);
    gunBarrel.quaternion.copy(_barrelAimQ);
  }
  gun.updateWorldMatrix(true, true);
  camera.quaternion.copy(_aimQ);
  _aimDir.set(0, 0, -1).applyQuaternion(_aimQ);
  if (gunBarrel) _camRig.copy(gunBarrel.getWorldPosition(_gunEye)).addScaledVector(_aimDir, -1.05);
  else _camRig.copy(player.position).add(V3(0, 0.75, -0.25).applyQuaternion(base));
  camera.position.lerp(_camRig, Math.min(1, 20 * dt));
  camera.position.x += (Math.random() - .5) * shake * .18;
  camera.position.y += (Math.random() - .5) * shake * .18;
  recoil *= Math.pow(.0008, dt);
}
const _rq = new T.Quaternion(), _rqe = new T.Euler();
function _coneRecoil(pitch) { _rqe.set(pitch, 0, 0); return _rq.setFromEuler(_rqe); }

// Stop the player plane from passing through the airship or any enemy (both modes).
const airshipHalf = new T.Vector3();
const PLAYER_R = CFG.PLAYER.size * 0.4;
function resolvePlayerCollisions() {
  if (!airship) return;
  // airship as an ellipsoid (it's long and thin — a sphere would be a poor fit)
  const l = player.position.clone().sub(airship.position);
  const hx = airshipHalf.x + PLAYER_R, hy = airshipHalf.y + PLAYER_R, hz = airshipHalf.z + PLAYER_R;
  const nx = l.x / hx, ny = l.y / hy, nz = l.z / hz;
  const norm = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (norm < 1 && norm > 1e-4) {
    const s = 1 / norm; // push out to the surface along the radial
    player.position.set(airship.position.x + l.x * s, airship.position.y + l.y * s, airship.position.z + l.z * s);
  }
  // enemies as spheres
  const er = CFG.ENEMY.size * 0.5 + PLAYER_R;
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = player.position.clone().sub(e.obj.position); const L = d.length();
    if (L < er && L > 1e-4) player.position.copy(e.obj.position).addScaledVector(d.multiplyScalar(1 / L), er);
  }
}
function updateFlight(dt) {
  // controls
  const pitchIn = ((keys.KeyW || keys.ArrowUp) ? 1 : 0) - ((keys.KeyS || keys.ArrowDown) ? 1 : 0);
  const rollIn = ((keys.KeyD || keys.ArrowRight) ? 1 : 0) - ((keys.KeyA || keys.ArrowLeft) ? 1 : 0);
  const yawIn = ((keys.KeyE || keys.ArrowRight) ? 1 : 0) - ((keys.KeyQ || keys.ArrowLeft) ? 1 : 0);
  const maneuver = Math.min(1, (Math.abs(pitchIn) + Math.abs(rollIn) + Math.abs(yawIn)) / 2);
  G.evasion = clamp(G.evasion + maneuver * dt * 1.5 - (maneuver ? 0 : dt * 0.75), 0, 1);
  flight.pitch += pitchIn * 2.05 * dt;
  flight.roll = lerp(flight.roll, -rollIn * 0.72, clamp(7 * dt, 0, 1));
  flight.yaw -= (yawIn * 1.65 + rollIn * 1.05) * dt; // right key turns right, left key turns left
  flight.pitch = clamp(flight.pitch, -1.1, 1.1);
  const throttle = (keys.ShiftLeft || keys.ShiftRight ? 1 : 0) - (keys.ControlLeft || keys.ControlRight ? 1 : 0);
  flight.speed = clamp(flight.speed + throttle * 8 * dt, 4.5, 27);

  const q = new T.Quaternion().setFromEuler(new T.Euler(flight.pitch, flight.yaw, flight.roll, 'YXZ'));
  const fwd = V3(0, 0, -1).applyQuaternion(q);
  flight.pos.addScaledVector(fwd, flight.speed * dt);
  flight.pos.y = clamp(flight.pos.y, CFG.FLOOR + 4, 90);

  player.position.copy(flight.pos); player.quaternion.copy(q);
  resolvePlayerCollisions();          // can't fly through enemies or the airship
  flight.pos.copy(player.position);   // keep the rig in sync after any push-out

  // chase camera
  const back = V3(0, 1.6, 7.5).applyQuaternion(q);
  _camPos.copy(flight.pos).add(back);
  camera.position.lerp(_camPos, 1 - Math.pow(0.0009, dt));
  _look.copy(flight.pos).addScaledVector(fwd, 8);
  camera.lookAt(_look);
  camera.position.x += (Math.random() - .5) * shake * .3;
  camera.position.y += (Math.random() - .5) * shake * .3;
}

function updateCinematicCamera(dt) {
  if (!G.cinematic) return false;
  G.cinematic.t += dt;
  const target = G.cinematic.target;
  const a = G.cinematic.t * 0.42;
  const desired = target.clone().add(V3(Math.sin(a) * 18, 8 + Math.sin(a * 0.7) * 2, 22 + Math.cos(a) * 9));
  camera.position.lerp(desired, 1 - Math.pow(0.003, dt));
  camera.lookAt(target.clone().add(V3(0, 1.5, 0)));
  camera.position.x += (Math.random() - .5) * shake * .22;
  camera.position.y += (Math.random() - .5) * shake * .22;
  return true;
}

/* ============================ SPAWN DIRECTOR ===================== */
let spawnT = 0;
function updateSpawns(dt) {
  spawnT -= dt;
  const elapsed = CFG.ROUND_TIME - G.timeLeft;
  const target = Math.min(CFG.MAX_ENEMIES_CAP, CFG.MAX_ENEMIES_BASE + Math.floor(elapsed / 20));
  if (spawnT <= 0 && enemies.length < target) {
    makeEnemy(); spawnT = rnd(1.5, 2.8);
  }
}

/* ============================ GAME FLOW ========================= */
async function startGame() {
  if (G.starting || G.running) return;
  G.starting = true;
  G.gameIndex++;             // 0 = first run of the session, used by difficulty()
  actionQuiz.reset();        // realign the question counter with the fresh deck
  ui.startBtn.disabled = true;
  ui.startBtn.textContent = 'Готовлю задания...';
  try {
    await actionQuiz.prepare(20);
  } catch (error) {
    console.warn('Question prefetch failed, fallback questions will be used:', error);
  }
  if (ui.storyCard) ui.storyCard.classList.add('hidden');
  ui.start.classList.add('hidden');
  while (enemies.length) {
    const e = enemies.pop();
    if (e?.obj) scene.remove(e.obj);
  }
  clearTransients();         // drop leftover tracers/debris/smoke from the last round
  // A loss hides the airship/plane and fractures them into debris; bring the
  // intact models back so an in-place restart isn't an empty sky.
  airship.visible = true;
  player.visible = true;
  if (propeller) propeller.visible = true;
  G.running = true;
  G.starting = false;
  G.over = false; G.endDisplayed = false; G.cinematic = null; G.evasion = 0; G.spawned = 0;
  G.shipHp = CFG.SHIP_HP; G.meHp = CFG.PLAYER_HP; G.ammo = CFG.AMMO_START;
  G.kills = 0; G.timeLeft = CFG.ROUND_TIME; G.playerSmokeT = 0; spawnT = 0;
  setShipHp(); setMeHp(); setAmmo(); setTime(); ui.kills.textContent = G.kills;
  // start in flight control, offset from the airship and flying past it, not into it
  player.position.copy(airship.position).add(V3(28, -1, 42));
  faceForward(player, player.position.clone().add(V3(0, 0, -80)));
  flight.pos.copy(player.position);
  G.mode = 'gun'; toggleMode(); // flip to flight + sync hint
  ui.reticle.classList.remove('show');
  for (let i = 0; i < CFG.MAX_ENEMIES_BASE; i++) makeEnemy();
}
async function showEndOverlay(won, msg) {
  if (G.endDisplayed) return;
  G.endDisplayed = true;
  ui.endIcon.textContent = won ? '🏆' : '💥';
  ui.endTitle.textContent = won ? 'Дирижабль удержан' : 'Поражение';
  ui.end.classList.toggle('win', won); ui.end.classList.toggle('lose', !won);
  ui.endMsg.textContent = `${msg}  Сбито: ${G.kills}.`;
  if (won) showVictoryStory();
  else if (ui.storyCard) ui.storyCard.classList.add('hidden');
  ui.end.classList.remove('hidden');
  try {
    const r = await fetch('/api/score', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kills: G.kills, won, survived: CFG.ROUND_TIME - G.timeLeft }) });
    const j = await r.json(); if (j && j.best != null) ui.endMsg.textContent += `  Рекорд: ${j.best}.`;
  } catch (e) {}
}

async function endGame(won, msg) {
  if (G.over) return;
  G.over = true; G.running = false;
  firing = false; renderer.domElement.style.cursor = 'default'; if (pointerLocked) document.exitPointerLock();
  showEndOverlay(won, msg);
}

/* ============================ MAIN LOOP ========================= */
const clock = new T.Clock(); let tt = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05); tt += dt;

  if (G.running && !G.over) {
    if (G.quizActive && G.quizPausesCombat) {
      firing = false;
      setTime();
    } else {
      G.timeLeft -= dt; if (G.timeLeft <= 0) { G.timeLeft = 0; setTime(); endGame(true, 'Время вышло — ты выстоял.'); }
      setTime();
      updateSpawns(dt);
      updateEnemies(dt);
      updatePlayerDamageSmoke(dt);

      // propeller spins faster in flight (with throttle), idles in gun mode
      if (propeller) {
        const rps = CFG.PROP_RPS * (G.mode === 'flight' ? (0.6 + flight.speed / 27 * 0.8) : 0.55);
        propeller.rotation.x += rps * Math.PI * 2 * dt;
      }

      if (G.mode === 'gun') {
        updateGunFlight(dt);
        updateGunCamera(dt);
        cooldown -= dt;
        if (firing && G.ammo > 0 && cooldown <= 0) { fire(); cooldown = FIRE_DT; }
      } else {
        updateFlight(dt);
      }
    }
  } else {
    if (!updateCinematicCamera(dt)) {
      // idle orbit before start
      camera.position.lerp(_camPos.set(Math.sin(tt * .15) * 26, 14, 30 + Math.cos(tt * .15) * 6), 0.02);
      if (airship) camera.lookAt(airship.position);
    }
  }

  muzzleLightI *= Math.pow(.0001, dt); muzzleLight.intensity = muzzleLightI;
  updateTracers(dt); updateDebris(dt); updateParticles(dt);
  shake *= Math.pow(.02, dt);

  renderer.render(scene, camera);
}

/* ============================ GO =============================== */
boot().then(() => { setShipHp(); setMeHp(); setAmmo(); setTime(); frame(); })
  .catch(err => { ui.loadMsg.textContent = 'Ошибка загрузки: ' + err.message; console.error(err); });
