/**
 * EasyRanked :: avatars des autres joueurs.
 *
 * Un seul operateur est modelise par (equipe, camo), puis clone : les clones
 * partagent geometries et materiaux, donc la memoire GPU ne bouge pas.
 * L'animation est procedurale (pas de squelette skinne) : on fait tourner les
 * groupes du rig, ce qui coute quelques matrices par personnage.
 */
import * as THREE from 'three';
import { buildDetailedArmoredCharacter, buildDetailedWeapon, resolveRig, resolveSockets }
  from './visuals.js';
import { cloneShared } from './geo.js';

const templates = new Map();

function template(team, camoId, camo) {
  const key = `${team}|${camoId}`;
  let t = templates.get(key);
  if (!t) {
    t = buildDetailedArmoredCharacter({ team, camo });
    templates.set(key, t);
  }
  return t;
}

const weaponTemplates = new Map();
function weaponTemplate(shape, camoId, camo, attachments) {
  const key = `${shape}|${camoId}|${JSON.stringify(attachments || {})}`;
  let t = weaponTemplates.get(key);
  if (!t) {
    t = buildDetailedWeapon({ shape, camo, attachments });
    weaponTemplates.set(key, t);
  }
  return t;
}

export class Avatar {
  /**
   * @param {object} info  { id, name, team, weapon, camo, attachments, bot, level }
   * @param {object} deps  { scene, camos, weapons }
   */
  constructor(info, deps) {
    this.info = info;
    this.scene = deps.scene;
    const camo = (deps.camos || []).find((c) => c.id === info.camo) || null;

    this.root = new THREE.Group();
    this.root.name = 'avatar:' + info.id;
    this.body = cloneShared(template(info.team ?? 0, info.camo || 'default', camo));
    this.root.add(this.body);
    // Le clone a perdu les references du rig (userData est serialise) : on les
    // retrouve par nom sur l'arbre clone.
    this.rig = resolveRig(this.body);

    // Arme portee : accrochee a la main droite, canon vers l'avant.
    const shape = deps.weapons?.[info.weapon]?.shape || 'carbine';
    this.weapon = cloneShared(weaponTemplate(shape, info.camo || 'default', camo, info.attachments));
    const wSockets = resolveSockets(this.weapon);
    this.weapon.scale.setScalar(1.0);
    // Le bras de l'avatar s'etend vers -Y (il pend) alors que le canon pointe
    // vers -Z : une rotation de -90 deg autour de X aligne le canon sur l'axe du
    // bras, donc vers l'avant une fois l'epaule levee en position de tir.
    this.rig.armR.hand.add(this.weapon);
    this.weapon.position.set(0.0, -0.075, 0.015);
    this.weapon.rotation.set(-Math.PI / 2 + 0.12, 0, 0);
    this.muzzle = wSockets.muzzleTip;

    this.walkPhase = Math.random() * Math.PI * 2;
    this.aim = 0;
    this.dead = false;
    this.deathTime = 0;
    this.prev = new THREE.Vector3();
    this.scene.add(this.root);

    // Plaque de nom au-dessus de la tete (visible pour les allies).
    this.label = makeLabel(info.name, info.team ?? 0);
    this.label.position.set(0, 2.08, 0);
    this.root.add(this.label);
  }

  /**
   * @param {object} s  etat interpole (cf. NetClient.interpolated)
   * @param {number} dt
   * @param {THREE.Vector3} viewer  position de la camera (orientation des plaques)
   * @param {boolean} ally
   */
  update(s, dt, viewer, ally) {
    const r = this.rig;
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;

    // Mort : bascule au sol, puis l'avatar reste couche jusqu'au respawn.
    if (!s.alive) {
      if (!this.dead) { this.dead = true; this.deathTime = 0; }
      this.deathTime = Math.min(1, this.deathTime + dt * 2.6);
      const t = easeOut(this.deathTime);
      this.body.rotation.x = -t * (Math.PI / 2 - 0.12);
      this.body.position.y = -t * 0.12;
      this.label.visible = false;
      return;
    }
    if (this.dead) {
      this.dead = false;
      this.body.rotation.x = 0;
      this.body.position.y = 0;
    }

    const speed = Math.hypot(s.vx || 0, s.vz || 0);
    const stance = s.stance ?? 1;

    // Accroupi / glissade : on plie les jambes et on baisse le buste.
    const crouch = 1 - THREE.MathUtils.clamp(stance, 0.55, 1);
    const crouchT = crouch / 0.45;
    r.hips.position.y = 0.95 - crouchT * 0.38;
    r.legL.thigh.rotation.x = crouchT * 0.95;
    r.legR.thigh.rotation.x = crouchT * 0.95;
    r.legL.shin.rotation.x = -crouchT * 1.5;
    r.legR.shin.rotation.x = -crouchT * 1.5;
    r.legL.foot.rotation.x = crouchT * 0.55;
    r.legR.foot.rotation.x = crouchT * 0.55;
    r.spine.rotation.x = crouchT * 0.22;

    // Cycle de marche : amplitude proportionnelle a la vitesse.
    if (speed > 0.35) {
      const cadence = s.sprinting ? 9.5 : 7.0;
      this.walkPhase += dt * cadence * Math.min(1.6, speed / 4.5);
      const amp = Math.min(1, speed / 6) * (s.sprinting ? 0.72 : 0.5) * (1 - crouchT * 0.55);
      const sw = Math.sin(this.walkPhase);
      const sw2 = Math.sin(this.walkPhase + Math.PI);
      r.legL.thigh.rotation.x += sw * amp;
      r.legR.thigh.rotation.x += sw2 * amp;
      r.legL.shin.rotation.x += Math.max(0, -sw) * amp * 1.25;
      r.legR.shin.rotation.x += Math.max(0, -sw2) * amp * 1.25;
      r.legL.foot.rotation.x += Math.max(0, sw) * amp * 0.45;
      r.legR.foot.rotation.x += Math.max(0, sw2) * amp * 0.45;
      // Le bassin monte et roule legerement a chaque appui.
      r.hips.position.y += Math.abs(Math.sin(this.walkPhase * 2)) * 0.035 * amp;
      r.hips.rotation.z = sw * 0.035 * amp;
      r.spine.rotation.y = sw * 0.1 * amp;
      // Le bras gauche tient l'arme : seul le droit balance librement.
      r.armL.shoulder.rotation.x = -sw * amp * 0.22;
    } else {
      this.walkPhase += dt * 1.2;
      r.hips.rotation.z *= 1 - Math.min(1, dt * 6);
      r.spine.rotation.y *= 1 - Math.min(1, dt * 6);
      r.armL.shoulder.rotation.x *= 1 - Math.min(1, dt * 6);
      // Respiration a l'arret.
      r.spine.position.y = 0.1 + Math.sin(this.walkPhase) * 0.008;
    }

    // Posture de tir : bras leves vers l'avant, buste tourne, tete inclinee.
    const wantAim = s.ads ? 1 : (s.sprinting ? 0.1 : 0.72);
    this.aim += (wantAim - this.aim) * Math.min(1, dt * 9);
    const a = this.aim;
    r.armR.shoulder.rotation.x = -1.28 * a;
    r.armR.shoulder.rotation.z = 0.34 * a;
    r.armR.upper.rotation.x = -0.18 * a;
    r.armR.fore.rotation.x = -0.95 * a;
    r.armL.shoulder.rotation.x += -1.1 * a;
    r.armL.shoulder.rotation.z = -0.62 * a;
    r.armL.fore.rotation.x = -1.25 * a;
    r.spine.rotation.y += -0.22 * a;
    r.head.rotation.x = THREE.MathUtils.clamp(-s.pitch, -0.9, 0.9) * (0.35 + 0.5 * a);
    r.head.rotation.y = 0.16 * a;

    // Recul visible quand l'avatar tire.
    if (s.firing) {
      r.armR.shoulder.rotation.x += 0.09;
      r.spine.rotation.x -= 0.03;
    }
    // Rechargement : la main gauche descend vers le chargeur.
    if (s.reloading) {
      r.armL.shoulder.rotation.x += 0.45;
      r.armL.fore.rotation.x += 0.5;
      r.armL.shoulder.rotation.z += 0.2;
    }

    // Les plaques de nom font toujours face au joueur.
    // Les sprites font deja face a la camera : on ne regle que la taille, pour
    // que la plaque reste lisible a toutes les distances.
    this.label.visible = ally;
    if (ally) {
      const d = this.root.position.distanceTo(viewer);
      const k = THREE.MathUtils.clamp(d * 0.055, 0.5, 2.4);
      this.label.scale.set(1.2 * k, 0.3 * k, 1);
    }
  }

  muzzleWorld(out = new THREE.Vector3()) {
    this.muzzle.getWorldPosition(out);
    return out;
  }

  dispose() {
    this.scene.remove(this.root);
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

/** Plaque de nom : un sprite dessine une fois sur un canvas. */
function makeLabel(name, team) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(8,12,16,0.55)';
  ctx.beginPath();
  ctx.roundRect(8, 14, 240, 36, 8);
  ctx.fill();
  ctx.fillStyle = team === 1 ? '#f09a6e' : '#8ec0f5';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(name).slice(0, 16), 128, 33);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: true, opacity: 0.9,
  }));
  sprite.scale.set(1.2, 0.3, 1);
  return sprite;
}

function easeOut(t) { return 1 - (1 - t) ** 3; }

/** Libere les modeles de reference (changement de partie). */
export function clearTemplates() {
  templates.clear();
  weaponTemplates.clear();
}
