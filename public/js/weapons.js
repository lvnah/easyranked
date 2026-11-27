/**
 * EasyRanked :: arme en vue 1ere personne.
 *
 * Gere la cadence, le chargeur, la visee (ADS), le recul (vertical + horizontal
 * avec schema reproductible), la dispersion, et l'animation du modele : balancement
 * de marche, recul visuel, rechargement, inspection.
 */
import * as THREE from 'three';
import { buildDetailedWeapon, buildFirstPersonArms, applyAttachments } from './visuals.js';

const V = new THREE.Vector3();

export class WeaponRuntime {
  /**
   * @param {object} cfg    stats resolues (Config::resolveWeapon cote PHP)
   * @param {object} opts   { camo, attachments, viewModelScene, engine }
   */
  constructor(cfg, opts = {}) {
    this.engine = opts.engine;
    this.scene = opts.viewModelScene;
    this.rig = new THREE.Group();
    this.scene.add(this.rig);

    this.ammo = cfg.magazine;
    this.reserve = cfg.reserve;
    this.grenades = opts.grenades ?? 2;
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextShot = 0;
    this.shotsFired = 0;
    this.lastShotAt = -99;
    this.ads = 0;                   // 0 = hanche, 1 = visee complete
    this.recoil = new THREE.Vector2();        // decalage camera applique
    this.recoilVel = new THREE.Vector2();
    this.visualKick = 0;
    this.sway = new THREE.Vector2();
    this.bob = 0;
    this.inspect = 0;

    this.setWeapon(cfg, opts.camo, opts.attachments);
  }

  /** (Re)construit le modele 3D pour une arme / un camo / des accessoires. */
  setWeapon(cfg, camo = null, attachments = {}) {
    this.cfg = cfg;
    this.camo = camo;
    this.attachments = attachments || {};

    this.rig.clear();
    this.model = buildDetailedWeapon({ shape: cfg.shape, camo, attachments: this.attachments });
    this.arms = buildFirstPersonArms({ camo });

    // Trois poses interpolees. Elles sont absolues (jamais additives) : une
    // rotation additive autour de la poignee ferait passer le canon a travers
    // le point de vue en sprint.
    //
    // Repos : arme a droite et en bas, canon legerement converge vers le centre.
    this.restPos = new THREE.Vector3(0.19, -0.2, -0.42);
    this.restRot = new THREE.Euler(0.025, 0.2, 0.015);
    // Visee : l'organe de visee est amene exactement sur l'axe de la camera.
    const sight = this.model.userData.sightHeight ?? 0.12;
    this.adsPos = new THREE.Vector3(0, -sight, -0.26);
    this.adsRot = new THREE.Euler(0, 0, 0);
    // Sprint : arme basculee en travers du corps, canon vers le bas a gauche.
    this.sprintPos = new THREE.Vector3(0.27, -0.3, -0.3);
    this.sprintRot = new THREE.Euler(0.3, 0.68, 0.24);
    this.sprintBlend = 0;

    this.holder = new THREE.Group();
    this.holder.add(this.model);
    this.rig.add(this.holder);

    // Les mains sont greffees sur l'arme : elles suivent tous ses mouvements.
    // Le groupe "main" se trouve a z = -0.055 dans le bras, donc le bras est
    // recule de cette valeur pour que la paume tombe pile sur le point de prise.
    const sockets = this.model.userData.sockets;
    const HAND_OFFSET = 0.055;
    const { right, left } = this.arms.userData.arms;

    // Main de tir : enroulee sur la poignee pistolet (derriere le pontet).
    right.arm.position.set(0.03, -0.105, sockets.stock.position.z + HAND_OFFSET + 0.015);
    right.arm.rotation.set(0.42, 0.26, 0.0);

    // Main avant : sous le garde-main, doigts enroules autour du tube.
    left.arm.position.set(-0.015, sockets.grip.position.y - 0.012,
                          sockets.grip.position.z + HAND_OFFSET);
    left.arm.rotation.set(0.72, -0.44, -0.16);
    left.hand.rotation.y = -Math.PI / 2;     // les doigts enlacent l'axe du canon
    this.model.add(this.arms);

    this.muzzle = this.model.userData.sockets.muzzleTip;
    this.ejectPort = this.model.userData.sockets.ejectPort;
    this.laser = this.model.userData.laser;
    if (this.laser?.beam) this._makeLaserBeam();

    // Le chargeur peut avoir change de taille : on re-clampe les munitions.
    this.ammo = Math.min(this.ammo, cfg.magazine);
  }

  setAttachments(attachments) {
    this.attachments = attachments || {};
    applyAttachments(this.model, this.attachments, this.camo);
    const sight = this.model.userData.sightHeight ?? 0.12;
    this.adsPos.set(0, -sight, -0.26);
    this.laser = this.model.userData.laser;
    if (this.laser?.beam) this._makeLaserBeam();
  }

  _makeLaserBeam() {
    if (this.beam) this.beam.parent?.remove(this.beam);
    const geo = new THREE.CylinderGeometry(0.0016, 0.0016, 1, 4, 1, true);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, -0.5);
    this.beam = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: this.laser.color, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.beam.scale.z = 30;
    this.laser.node.add(this.beam);
  }

  /* ------------------------------------------------------------- etats */

  get magSize() { return this.cfg.magazine; }
  get isEmpty() { return this.ammo <= 0; }
  get adsFactor() { return this.ads; }

  canFire(now) {
    return !this.reloading && this.ammo > 0 && now >= this.nextShot;
  }

  /**
   * Consomme une balle et calcule le recul.
   * @returns {{spread:number}} dispersion a appliquer a la direction
   */
  fire(now, moving) {
    this.ammo--;
    this.nextShot = now + this.cfg.fireInterval;
    this.lastShotAt = now;
    this.shotsFired++;

    // Recul : composante verticale croissante puis saturee, horizontale
    // alternee selon un motif reproductible (maitrisable par le joueur).
    const n = this.shotsFired;
    const ramp = Math.min(1, 0.45 + n * 0.09);
    const vert = this.cfg.recoilVert * ramp * (this.ads > 0.5 ? 0.78 : 1.0);
    const patt = Math.sin(n * 1.37) * 0.6 + Math.sin(n * 0.41) * 0.4;
    const horiz = this.cfg.recoilHoriz * patt * this.cfg.pattern * (this.ads > 0.5 ? 0.7 : 1.0);

    this.recoilVel.y += vert * 6.0;
    this.recoilVel.x += horiz * 6.0;
    this.visualKick = Math.min(1.4, this.visualKick + this.cfg.kick * 11);

    const base = this.ads > 0.5 ? this.cfg.spreadAds : this.cfg.spreadHip;
    const bloom = Math.min(1.8, n * 0.055);
    const move = moving ? this.cfg.spreadMoveMul : 1;
    return { spread: base * (1 + bloom) * move };
  }

  startReload(now) {
    if (this.reloading || this.reserve <= 0 || this.ammo >= this.cfg.magazine) return false;
    this.reloading = true;
    this.reloadStart = now;
    this.reloadEnd = now + (this.ammo === 0 ? this.cfg.reloadEmptyTime : this.cfg.reloadTime);
    return true;
  }

  cancelReload() {
    this.reloading = false;
  }

  /** Synchronise l'etat autoritaire renvoye par le serveur. */
  syncFromServer(ammo, reloading) {
    if (typeof ammo === 'number' && ammo >= 0) this.ammo = ammo;
    if (typeof reloading === 'boolean') this.reloading = reloading;
  }

  /* -------------------------------------------------------- mise a jour */

  update(dt, now, state) {
    // Fin de rechargement.
    if (this.reloading && now >= this.reloadEnd) {
      const need = this.cfg.magazine - this.ammo;
      const take = Math.min(need, this.reserve);
      this.ammo += take;
      this.reserve -= take;
      this.reloading = false;
      this.shotsFired = 0;
    }
    // Retour au centre apres un tir (recuperation du recul).
    if (now - this.lastShotAt > 0.22) {
      this.shotsFired = Math.max(0, this.shotsFired - dt * 9);
    }

    // Integration du recul : ressort amorti vers zero.
    const rec = this.cfg.recovery;
    this.recoilVel.multiplyScalar(Math.max(0, 1 - dt * 14));
    this.recoil.x += this.recoilVel.x * dt;
    this.recoil.y += this.recoilVel.y * dt;
    this.recoil.multiplyScalar(Math.max(0, 1 - dt * rec));
    this.visualKick *= Math.max(0, 1 - dt * 13);

    // Transition de visee.
    const wantAds = state.ads && !this.reloading && !state.sprinting ? 1 : 0;
    const adsSpeed = dt / Math.max(0.05, this.cfg.adsTime);
    this.ads += Math.sign(wantAds - this.ads) * Math.min(Math.abs(wantAds - this.ads), adsSpeed);
    this.ads = Math.max(0, Math.min(1, this.ads));

    this._animate(dt, now, state);
  }

  /** Pose du modele : interpolation hanche <-> visee + balancements. */
  _animate(dt, now, state) {
    const a = smoothstep(this.ads);
    const speed = Math.hypot(state.velocity.x, state.velocity.z);
    const moving = speed > 0.6 && state.grounded;

    // Balancement de marche : plus ample a la hanche, presque nul en visee.
    this.bob += dt * (state.sprinting ? 13 : 9) * Math.min(1, speed / 6);
    const bobAmp = (moving ? 1 : 0) * (1 - a * 0.85) * (state.sprinting ? 0.022 : 0.012);
    const bobX = Math.cos(this.bob) * bobAmp;
    const bobY = Math.abs(Math.sin(this.bob)) * bobAmp * 0.8;

    // Inertie de visee : l'arme traine derriere la camera.
    const swayTarget = new THREE.Vector2(
      THREE.MathUtils.clamp(-state.lookDelta.x * 0.9, -0.05, 0.05),
      THREE.MathUtils.clamp(-state.lookDelta.y * 0.9, -0.05, 0.05)
    );
    this.sway.lerp(swayTarget, Math.min(1, dt * 11));

    // Melange des trois poses : repos -> visee (facteur a), puis repos -> sprint.
    const wantSprint = state.sprinting && !state.ads && moving ? 1 : 0;
    this.sprintBlend += Math.sign(wantSprint - this.sprintBlend)
      * Math.min(Math.abs(wantSprint - this.sprintBlend), dt * (wantSprint ? 6 : 9));
    const sp2 = smoothstep(Math.max(0, Math.min(1, this.sprintBlend))) * (1 - a);

    const pos = V.copy(this.restPos).lerp(this.adsPos, a).lerp(this.sprintPos, sp2);
    this.holder.position.set(
      pos.x + bobX + this.sway.x * (1 - a * 0.8),
      pos.y + bobY + this.sway.y * (1 - a * 0.8) - this.visualKick * 0.012,
      pos.z + this.visualKick * 0.045
    );

    const mixRot = (key) => THREE.MathUtils.lerp(
      THREE.MathUtils.lerp(this.restRot[key], this.adsRot[key], a),
      this.sprintRot[key], sp2
    );
    const rx = mixRot('x') - this.visualKick * 0.07
             + (moving ? Math.sin(this.bob * 0.5) * 0.008 * (1 - a) : 0);
    const ry = mixRot('y') + this.sway.x * 0.9 * (1 - a * 0.7);
    const rz = mixRot('z') + this.sway.x * 0.5 * (1 - a);
    this.holder.rotation.set(rx, ry, rz);

    // Glissade : l'arme descend et s'incline.
    if (state.sliding) {
      this.holder.position.y -= 0.045;
      this.holder.rotation.z += 0.16;
    }

    // Rechargement : descente de l'arme, chargeur ejecte puis reinsere.
    if (this.reloading) {
      const total = this.reloadEnd - this.reloadStart;
      const t = THREE.MathUtils.clamp((now - this.reloadStart) / total, 0, 1);
      const dip = Math.sin(t * Math.PI);
      this.holder.position.y -= dip * 0.13;
      this.holder.position.x += dip * 0.03;
      this.holder.rotation.x += dip * 0.5;
      this.holder.rotation.z -= dip * 0.35;
      const mag = this.model.userData.magGroup;
      if (mag) {
        // Le chargeur tombe sur la premiere moitie, revient sur la seconde.
        const drop = t < 0.45 ? t / 0.45 : Math.max(0, 1 - (t - 0.45) / 0.3);
        mag.position.y = mag.userData.baseY ??= mag.position.y;
        mag.position.y = (mag.userData.baseY) - drop * 0.26;
        mag.rotation.x = -drop * 0.5;
      }
    } else {
      const mag = this.model.userData.magGroup;
      if (mag && mag.userData.baseY !== undefined) {
        mag.position.y = mag.userData.baseY;
        mag.rotation.x = 0;
      }
    }

    // Inspection (touche I) : rotation de presentation.
    if (this.inspect > 0) {
      this.inspect = Math.max(0, this.inspect - dt / 1.6);
      const t = 1 - this.inspect;
      const ease = Math.sin(t * Math.PI);
      this.holder.rotation.y += ease * 1.1;
      this.holder.rotation.z += ease * 0.5;
      this.holder.position.z += ease * 0.09;
      this.holder.position.y -= ease * 0.03;
    }

    // Faisceau laser : s'arrete au premier obstacle.
    if (this.beam) {
      this.beam.visible = this.ads < 0.6;
      if (state.laserDistance) this.beam.scale.z = Math.min(40, state.laserDistance);
    }
  }

  startInspect() { if (this.inspect <= 0) this.inspect = 1; }

  /** Point de sortie du canon en coordonnees monde (pour flash/traceuse). */
  muzzleWorld(out = new THREE.Vector3()) {
    this.muzzle.getWorldPosition(out);
    return out;
  }

  dispose() {
    this.rig.parent?.remove(this.rig);
  }
}

function smoothstep(t) { return t * t * (3 - 2 * t); }
