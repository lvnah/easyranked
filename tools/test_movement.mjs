/**
 * EasyRanked :: test des deplacements, hors navigateur.
 *
 *   npm install          (une fois : Node a besoin de resoudre "three")
 *   node tools/test_movement.mjs
 *
 * Simule le controleur sur un sol plat sans obstacle et verifie les vitesses,
 * la glissade, le saut et le temps de montee en visee. C'est ce test qui a
 * revele que le sprint plafonnait sous sa vitesse nominale.
 */
import './shim-canvas.mjs';
import * as THREE from 'three';
import { PlayerController } from '../public/js/player.js';

// --- physique de substitution : plan infini a y=0, pas d'obstacle
const physics = {
  overlaps: () => null,
  isGrounded: (pos) => pos.y <= 0.001,
  groundAt: () => 0,
  raycast: () => null,
  lineOfSight: () => true,
  move(pos, delta, height) {
    pos.x += delta.x; pos.z += delta.z; pos.y += delta.y;
    let grounded = false;
    if (pos.y <= 0) { pos.y = 0; grounded = true; }
    return { grounded, hitWall: false, ceiling: false };
  },
};

// --- moteur de substitution : seules les cameras sont touchees
const engine = {
  camera: new THREE.PerspectiveCamera(80, 1.78, 0.1, 300),
  viewModelCamera: new THREE.PerspectiveCamera(60, 1.78, 0.01, 6),
  viewModelScene: new THREE.Scene(),
};

// --- entrees pilotees a la main
const input = {
  forward: false, back: false, left: false, right: false,
  sprint: false, crouch: false, ads: false, fire: false, sensitivity: 1,
  consumeJump() { const v = this._j; this._j = false; return v; },
  consumeReload() { return false; }, consumeGrenade() { return false; },
  consumeInspect() { return false; }, consumeFire() { return false; },
  jump() { this._j = true; },
};

const cfg = {
  id: 'mk18', name: 'MK18', shape: 'carbine', damage: 26, rpm: 760, magazine: 30, reserve: 150,
  reloadTime: 2.1, reloadEmptyTime: 2.75, adsTime: 0.24, spreadHip: 2.6, spreadAds: 0.28,
  spreadMoveMul: 1.9, recoilVert: 0.62, recoilHoriz: 0.26, recovery: 7.5, kick: 0.045,
  pattern: 0.55, rangeFull: 34, rangeFalloff: 62, falloffMin: 0.62, mobility: 1,
  bulletsPerShot: 1, auto: true, zoom: 1.12, silent: false, fireInterval: 60 / 760,
};

const player = new PlayerController({
  engine, physics, input, weaponCfg: cfg, camo: null, attachments: {},
  balance: { maxHealth: 150, shieldMax: 50, respawnDelay: 3.2, regenDelay: 5, regenRate: 22 },
  grenades: 2,
});
player.teleport(new THREE.Vector3(0, 0, 0));
player.yaw = 0;                       // avance vers -Z

const DT = 1 / 120;
let t = 0;
const step = (n) => { for (let i = 0; i < n; i++) { t += DT; player.update(DT, t); } };
const speed = () => Math.hypot(player.vel.x, player.vel.z);

// 1) marche
input.forward = true;
step(240);
const walk = speed();

// 2) sprint
input.sprint = true;
step(240);
const sprint = speed();

// 3) visee
input.ads = true; step(180);
const ads = speed();
input.ads = false; step(180);

// 4) accroupi
input.sprint = false; input.crouch = true; step(180);
const crouch = { v: speed(), h: player.height, eye: player.eyeOffset };
input.crouch = false; step(180);

// 5) glissade
input.sprint = true; step(300);
const beforeSlide = speed();
input.crouch = true;
let slideFrames = 0, slidePeak = 0, eyeMin = 9, rollMax = 0, dist = 0;
const x0 = player.pos.x, z0 = player.pos.z;
for (let i = 0; i < 300; i++) {
  t += DT; player.update(DT, t);
  if (player.sliding) {
    slideFrames++;
    slidePeak = Math.max(slidePeak, speed());
    eyeMin = Math.min(eyeMin, player.eyeOffset);
    rollMax = Math.max(rollMax, Math.abs(player.cameraRoll));
  }
}
dist = Math.hypot(player.pos.x - x0, player.pos.z - z0);
input.crouch = false;

// 6) saut
step(120);
const yBefore = player.pos.y;
input.jump();
let apex = 0, airFrames = 0;
for (let i = 0; i < 200; i++) { t += DT; player.update(DT, t); apex = Math.max(apex, player.pos.y);
  if (!player.grounded) airFrames++; }

// 7) temps de montee en visee
input.ads = true;
let adsFrames = 0;
while (player.weapon.ads < 0.99 && adsFrames < 600) { t += DT; player.update(DT, t); adsFrames++; }
const adsTime = adsFrames * DT;

const r = (v) => Math.round(v * 100) / 100;
console.log(`marche          ${r(walk)} m/s          (attendu ~4.7)`);
console.log(`sprint          ${r(sprint)} m/s          (attendu ~7.4)`);
console.log(`visee           ${r(ads)} m/s          (attendu ~4.7 x 0.62 = 2.9)`);
console.log(`accroupi        ${r(crouch.v)} m/s  hauteur ${r(crouch.h)} m  oeil ${r(crouch.eye)} m`);
console.log(`avant glissade  ${r(beforeSlide)} m/s`);
console.log(`GLISSADE        ${slideFrames} frames (${r(slideFrames * DT)} s)  pointe ${r(slidePeak)} m/s`);
console.log(`                oeil min ${r(eyeMin)} m (debout 1.62)  roulis ${r(rollMax)} rad  distance ${r(dist)} m`);
console.log(`cooldown        ${r(player.slideCooldown)} s`);
console.log(`saut            apex ${r(apex)} m, ${airFrames} frames en l'air (${r(airFrames * DT)} s)`);
console.log(`montee en visee ${r(adsTime)} s           (attendu ${cfg.adsTime} s)`);

let fail = 0;
const check = (ok, label) => { if (!ok) { console.log('  ECHEC: ' + label); fail++; } };
check(walk > 4.2 && walk < 5.0, 'vitesse de marche');
check(sprint > 6.8 && sprint < 7.6, 'vitesse de sprint');
check(ads > 2.5 && ads < 3.3, 'vitesse en visee');
check(crouch.h < 1.2 && crouch.h > 1.0, 'hauteur accroupi');
check(slideFrames > 60, 'la glissade se declenche et dure');
check(slidePeak > sprint, "la glissade conserve (et amplifie) l'inertie");
check(eyeMin < 1.05, 'la camera plonge pendant la glissade');
check(rollMax > 0.04, 'roulis de camera en glissade');
check(apex > 0.8 && apex < 1.6, 'hauteur de saut');
check(Math.abs(adsTime - cfg.adsTime) < 0.06, 'temps de montee en visee');
console.log(fail === 0 ? '\nTOUS LES CONTROLES PASSENT' : `\n${fail} CONTROLE(S) EN ECHEC`);
process.exit(fail === 0 ? 0 : 1);
