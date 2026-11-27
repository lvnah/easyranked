/**
 * EasyRanked :: controleur du joueur local.
 *
 * Clavier AZERTY par defaut (ZQSD), Espace = saut, Shift = sprint,
 * C / Ctrl = accroupi, Shift+C ou Shift+Ctrl en course = glissade,
 * Clic gauche = tir, Clic droit = visee, R = recharger, G = grenade,
 * I = inspecter l'arme.
 *
 * La glissade conserve l'inertie : on garde la vitesse acquise en sprint,
 * on l'amortit progressivement, et la camera descend franchement.
 */
import * as THREE from 'three';
import { Physics, PLAYER, rayPlayer } from './physics.js';
import { WeaponRuntime } from './weapons.js';

const SPEED = {
  walk: 4.7,
  sprint: 7.4,
  crouch: 2.7,
  adsMul: 0.62,
  air: 1.6,
  accelGround: 62,
  accelAir: 13,
  frictionGround: 11.5,
  frictionAir: 0.28,
  jump: 6.5,
  gravity: 19.6,
  slideBoost: 1.22,
  slideMax: 9.6,
  slideFriction: 3.1,
  slideMinSpeed: 2.4,
  slideCooldown: 0.75,
  slideMaxTime: 1.1,
};

export class PlayerController {
  /**
   * @param {object} deps { engine, physics, input, weaponCfg, camo, attachments, balance }
   */
  constructor(deps) {
    this.engine = deps.engine;
    this.physics = deps.physics;
    this.input = deps.input;
    this.balance = deps.balance;

    this.pos = new THREE.Vector3(0, 0, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.lookDelta = new THREE.Vector2();

    this.height = PLAYER.height;
    this.targetHeight = PLAYER.height;
    this.eyeOffset = PLAYER.eye;
    this.crouching = false;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.grounded = true;
    this.sprinting = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.stepPhase = 0;

    this.health = this.balance.maxHealth;
    this.shield = 0;
    this.alive = true;
    this.team = 0;

    this.cameraRoll = 0;
    this.cameraKick = new THREE.Vector2();
    this.shake = 0;

    this.weapon = new WeaponRuntime(deps.weaponCfg, {
      camo: deps.camo,
      attachments: deps.attachments,
      viewModelScene: this.engine.viewModelScene,
      engine: this.engine,
      grenades: deps.grenades ?? 2,
    });

    /** Callbacks branches par main.js */
    this.onShoot = null;       // (origin, dir, spread) -> void
    this.onReload = null;
    this.onGrenade = null;     // (origin, dir) -> void
    this.onStep = null;
  }

  teleport(v) {
    this.pos.copy(v);
    this.vel.set(0, 0, 0);
    this.sliding = false;
    this.slideTime = 0;
    this.height = this.targetHeight = PLAYER.height;
  }

  respawn(v) {
    this.teleport(v);
    this.health = this.balance.maxHealth;
    this.shield = 0;
    this.alive = true;
    this.weapon.ammo = this.weapon.cfg.magazine;
    this.weapon.reserve = this.weapon.cfg.reserve;
    this.weapon.reloading = false;
    this.weapon.shotsFired = 0;
  }

  /* --------------------------------------------------------------- vue */

  applyMouse(dx, dy, sensitivity) {
    if (!this.alive) return;
    // La visee ralentit la rotation proportionnellement au grossissement.
    const zoomMul = 1 / (1 + (this.weapon.ads * (this.weapon.cfg.zoom - 1)) * 0.85);
    const s = sensitivity * 0.0022 * zoomMul;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = Math.max(-1.52, Math.min(1.52, this.pitch));
    this.lookDelta.set(dx * s, dy * s);
  }

  /** Direction de visee, recul compris. */
  aimDirection(out = new THREE.Vector3()) {
    const yaw = this.yaw - this.weapon.recoil.x * 0.01;
    const pitch = THREE.MathUtils.clamp(this.pitch + this.weapon.recoil.y * 0.01, -1.55, 1.55);
    out.set(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch)
    );
    return out;
  }

  eyePosition(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + this.eyeOffset, this.pos.z);
  }

  /* ------------------------------------------------------------ update */

  update(dt, now) {
    const input = this.input;
    if (!this.alive) {
      this.lookDelta.multiplyScalar(0.8);
      this.weapon.update(dt, now, this._weaponState());
      this._updateCamera(dt);
      return;
    }

    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (input.consumeJump()) this.jumpBuffer = 0.14;

    /* ----------------------------------------------- intention de mouvement */
    const wish = new THREE.Vector3();
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
    if (input.forward) wish.add(fwd);
    if (input.back) wish.sub(fwd);
    if (input.right) wish.add(right);
    if (input.left) wish.sub(right);
    const wishing = wish.lengthSq() > 0;
    if (wishing) wish.normalize();

    const horizSpeed = Math.hypot(this.vel.x, this.vel.z);

    /* ------------------------------------------------------ accroupi / glissade */
    const wantCrouch = input.crouch;
    // Declenchement de glissade : en course, en avant, au sol, hors cooldown.
    if (wantCrouch && input.sprint && this.grounded && !this.sliding
        && this.slideCooldown <= 0 && horizSpeed > SPEED.walk * 0.92 && input.forward) {
      this.sliding = true;
      this.slideTime = 0;
      // Conservation (et legere amplification) de l'inertie acquise.
      const boost = Math.min(SPEED.slideMax, horizSpeed * SPEED.slideBoost);
      const dir = horizSpeed > 0.1
        ? new THREE.Vector3(this.vel.x, 0, this.vel.z).normalize()
        : fwd.clone();
      this.vel.x = dir.x * boost;
      this.vel.z = dir.z * boost;
      this.shake = Math.max(this.shake, 0.25);
    }

    if (this.sliding) {
      this.slideTime += dt;
      const sp = Math.hypot(this.vel.x, this.vel.z);
      // Fin de glissade : trop lente, trop longue, en l'air, ou touche relachee.
      if (sp < SPEED.slideMinSpeed || this.slideTime > SPEED.slideMaxTime
          || !this.grounded || !wantCrouch) {
        this.sliding = false;
        this.slideCooldown = SPEED.slideCooldown;
      }
    }

    this.crouching = wantCrouch && !this.sliding;
    this.sprinting = input.sprint && wishing && input.forward && !this.crouching
                  && !this.sliding && this.grounded && !input.ads;

    // Hauteur de capsule : on ne se releve que si le plafond le permet.
    let wantHeight = PLAYER.height;
    if (this.sliding) wantHeight = PLAYER.slideHeight;
    else if (this.crouching) wantHeight = PLAYER.crouchHeight;
    if (wantHeight > this.height) {
      const probe = this.pos.clone();
      if (this.physics.overlaps(probe, wantHeight)) wantHeight = this.height;
    }
    this.targetHeight = wantHeight;
    this.height += (this.targetHeight - this.height) * Math.min(1, dt * 14);

    /* ----------------------------------------------------------- vitesses */
    let maxSpeed;
    if (this.sliding) maxSpeed = SPEED.slideMax;
    else if (this.crouching) maxSpeed = SPEED.crouch;
    else if (this.sprinting) maxSpeed = SPEED.sprint;
    else maxSpeed = SPEED.walk;
    if (input.ads && !this.sliding) maxSpeed *= SPEED.adsMul;
    maxSpeed *= this.weapon.cfg.mobility;

    /* -------------------------------------------------- integration horizontale */
    if (this.sliding) {
      // En glissade on ne pousse plus : seule une correction laterale reste possible.
      const fric = Math.max(0, 1 - SPEED.slideFriction * dt);
      this.vel.x *= fric;
      this.vel.z *= fric;
      if (wishing) {
        this.vel.x += wish.x * 7.0 * dt;
        this.vel.z += wish.z * 7.0 * dt;
      }
    } else if (this.grounded) {
      const accel = SPEED.accelGround * dt;
      if (wishing) {
        this.vel.x += wish.x * accel;
        this.vel.z += wish.z * accel;
      }
      const fric = Math.max(0, 1 - SPEED.frictionGround * dt);
      this.vel.x *= fric;
      this.vel.z *= fric;
      const sp = Math.hypot(this.vel.x, this.vel.z);
      if (sp > maxSpeed) {
        const k = maxSpeed / sp;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    } else {
      // En l'air : controle limite (le strafe reste possible, pas la relance).
      const accel = SPEED.accelAir * dt;
      if (wishing) {
        this.vel.x += wish.x * accel;
        this.vel.z += wish.z * accel;
      }
      const sp = Math.hypot(this.vel.x, this.vel.z);
      const airCap = Math.max(maxSpeed, SPEED.sprint) * 1.05;
      if (sp > airCap) {
        const k = airCap / sp;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    }

    /* ------------------------------------------------------------- saut */
    if (this.jumpBuffer > 0 && (this.grounded || this.coyote > 0)) {
      this.vel.y = SPEED.jump;
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.grounded = false;
      if (this.sliding) { this.sliding = false; this.slideCooldown = SPEED.slideCooldown * 0.6; }
    }
    this.vel.y -= SPEED.gravity * dt;
    this.vel.y = Math.max(-45, this.vel.y);

    /* --------------------------------------------------------- collision */
    const delta = new THREE.Vector3(this.vel.x * dt, this.vel.y * dt, this.vel.z * dt);
    const beforeY = this.vel.y;
    const res = this.physics.move(this.pos, delta, this.height);
    if (res.grounded) {
      if (beforeY < -9) this.shake = Math.max(this.shake, Math.min(0.5, -beforeY / 45));
      this.vel.y = 0;
    }
    if (res.ceiling) this.vel.y = Math.min(0, this.vel.y);
    if (res.hitWall) {
      // On annule la composante perdue pour eviter de "coller" au mur.
      if (this.sliding && Math.hypot(this.vel.x, this.vel.z) < SPEED.slideMinSpeed) this.sliding = false;
    }
    this.grounded = res.grounded || this.physics.isGrounded(this.pos, this.height);

    /* ------------------------------------------------- bruit de pas (cadence) */
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (this.grounded && sp > 1.2 && !this.sliding) {
      this.stepPhase += dt * sp * (this.crouching ? 0.9 : 1.55);
      if (this.stepPhase > 1) {
        this.stepPhase = 0;
        this.onStep?.(sp, this.crouching);
      }
    }

    /* ----------------------------------------------------------- armement */
    this._handleWeapon(dt, now);

    this.weapon.update(dt, now, this._weaponState());
    this._updateCamera(dt);
    this.lookDelta.multiplyScalar(Math.max(0, 1 - dt * 12));
  }

  _weaponState() {
    return {
      ads: this.input.ads && !this.sprinting,
      sprinting: this.sprinting,
      sliding: this.sliding,
      grounded: this.grounded,
      velocity: this.vel,
      lookDelta: this.lookDelta,
      laserDistance: this.laserDistance,
    };
  }

  _handleWeapon(dt, now) {
    const w = this.weapon;
    const input = this.input;

    if (input.consumeReload()) {
      if (w.startReload(now)) this.onReload?.();
    }
    if (input.consumeInspect()) w.startInspect();
    if (input.consumeGrenade() && this.weapon.grenades > 0) {
      this.weapon.grenades--;
      const origin = this.eyePosition();
      const dir = this.aimDirection();
      this.onGrenade?.(origin, dir);
    }

    // Tir : automatique tant que le bouton est maintenu, semi sinon.
    const wantFire = w.cfg.auto ? input.fire : input.consumeFire();
    if (wantFire && w.canFire(now)) {
      if (w.reloading) w.cancelReload();
      const moving = Math.hypot(this.vel.x, this.vel.z) > 1.4 || !this.grounded;
      const { spread } = w.fire(now, moving);

      const origin = this.eyePosition();
      const dir = this.aimDirection();
      // Dispersion : angle aleatoire dans un cone, racine carree pour une
      // repartition uniforme sur le disque.
      if (spread > 0.001) {
        const ang = Math.random() * Math.PI * 2;
        const mag = Math.sqrt(Math.random()) * THREE.MathUtils.degToRad(spread);
        const right = new THREE.Vector3(Math.cos(this.yaw), 0, Math.sin(this.yaw));
        const up = new THREE.Vector3().crossVectors(dir, right).normalize();
        dir.addScaledVector(right, Math.cos(ang) * mag)
           .addScaledVector(up, Math.sin(ang) * mag)
           .normalize();
      }
      this.onShoot?.(origin, dir, spread);
      this.shake = Math.max(this.shake, w.cfg.kick * 2.2);
    } else if (input.fire && w.isEmpty && !w.reloading && w.reserve > 0) {
      if (w.startReload(now)) this.onReload?.();
    }

    // Distance du faisceau laser (il doit s'arreter sur le premier obstacle).
    if (w.laser?.beam) {
      const hit = this.physics.raycast(this.eyePosition(), this.aimDirection(), 40);
      this.laserDistance = hit ? hit.dist : 40;
    }
  }

  /** Applique la pose de la camera : hauteur d'oeil, recul, roulis, secousse. */
  _updateCamera(dt) {
    const cam = this.engine.camera;

    // Hauteur d'oeil : suit la capsule (la glissade fait franchement plonger).
    const ratio = this.height / PLAYER.height;
    const targetEye = PLAYER.eye * ratio;
    this.eyeOffset += (targetEye - this.eyeOffset) * Math.min(1, dt * 16);

    // Roulis lateral : incline la vue lors du strafe et de la glissade.
    const lateral = this.vel.x * Math.cos(this.yaw) + this.vel.z * Math.sin(this.yaw);
    const rollTarget = THREE.MathUtils.clamp(-lateral * 0.0075, -0.055, 0.055)
                     + (this.sliding ? 0.065 : 0);
    this.cameraRoll += (rollTarget - this.cameraRoll) * Math.min(1, dt * 8);

    // Secousse decroissante (tirs, chutes, explosions).
    this.shake = Math.max(0, this.shake - dt * 2.4);
    const sx = this.shake * (Math.random() - 0.5) * 0.045;
    const sy = this.shake * (Math.random() - 0.5) * 0.045;

    cam.position.set(this.pos.x, this.pos.y + this.eyeOffset, this.pos.z);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(
      this.pitch + this.weapon.recoil.y * 0.01 + sy,
      this.yaw - this.weapon.recoil.x * 0.01 + sx,
      this.cameraRoll
    );

    // Champ de vision : se resserre en visee (grossissement de l'optique),
    // s'elargit en sprint (sensation de vitesse).
    const baseFov = 80;
    const adsFov = baseFov / this.weapon.cfg.zoom;
    const sprintFov = baseFov + 6;
    const target = this.weapon.ads > 0.01
      ? THREE.MathUtils.lerp(baseFov, adsFov, smoothstep(this.weapon.ads))
      : (this.sprinting ? sprintFov : baseFov);
    if (Math.abs(cam.fov - target) > 0.05) {
      cam.fov += (target - cam.fov) * Math.min(1, dt * 11);
      cam.updateProjectionMatrix();
    }

    // La camera de l'arme reprend l'orientation mais pas la position.
    const vm = this.engine.viewModelCamera;
    vm.rotation.order = 'YXZ';
    vm.rotation.set(0, 0, this.cameraRoll * 0.4);
    vm.fov = THREE.MathUtils.lerp(60, 48, smoothstep(this.weapon.ads));
    vm.updateProjectionMatrix();
  }

  takeDamage(amount) {
    if (!this.alive) return;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, amount);
      this.shield -= absorbed;
      amount -= absorbed;
    }
    this.health = Math.max(0, this.health - amount);
    this.shake = Math.max(this.shake, Math.min(0.8, amount / 60));
    if (this.health <= 0) this.alive = false;
  }

  snapshotInput(seq) {
    return {
      t: 'input',
      seq,
      pos: [round2(this.pos.x), round2(this.pos.y), round2(this.pos.z)],
      vel: [round2(this.vel.x), round2(this.vel.y), round2(this.vel.z)],
      yaw: round3(this.yaw),
      pitch: round3(this.pitch),
      stance: round2(this.height / PLAYER.height),
      flags: (this.sprinting ? 1 : 0) | (this.input.ads ? 2 : 0)
           | (this.sliding ? 4 : 0) | (this.grounded ? 8 : 0)
           | (this.weapon.reloading ? 16 : 0),
    };
  }
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;
function smoothstep(t) { return t * t * (3 - 2 * t); }

/* ======================================================================
 *  ENTREES
 * ==================================================================== */

/** Clavier + souris, avec verrouillage du pointeur. */
export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.sensitivity = opts.sensitivity ?? 1.0;
    this.layout = opts.layout ?? 'azerty';

    this.forward = this.back = this.left = this.right = false;
    this.sprint = this.crouch = this.ads = this.fire = false;
    this._jump = this._reload = this._grenade = this._inspect = this._fireTap = false;
    this.locked = false;
    this.mouse = { dx: 0, dy: 0 };
    this.onLockChange = null;
    this.onEscape = null;

    this._keys = new Set();
    this._bind();
  }

  _codeFor(action) {
    const azerty = {
      forward: ['KeyZ', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
      left: ['KeyQ', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    };
    const qwerty = {
      forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'],
      left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
    };
    return (this.layout === 'azerty' ? azerty : qwerty)[action];
  }

  _bind() {
    const down = (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      this._refresh();
      if (['Space', 'KeyR', 'KeyG', 'KeyI', 'ControlLeft', 'KeyC'].includes(e.code)) e.preventDefault();
      if (e.code === 'Space') this._jump = true;
      if (e.code === 'KeyR') this._reload = true;
      if (e.code === 'KeyG') this._grenade = true;
      if (e.code === 'KeyI') this._inspect = true;
      if (e.code === 'Escape') this.onEscape?.();
    };
    const up = (e) => { this._keys.delete(e.code); this._refresh(); };

    this._onKeyDown = down;
    this._onKeyUp = up;
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => { this._keys.clear(); this._refresh(); this.fire = false; });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.fire = true; this._fireTap = true; }
      if (e.button === 2) this.ads = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      if (e.button === 2) this.ads = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouse.dx += e.movementX || 0;
      this.mouse.dy += e.movementY || 0;
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.fire = false; this.ads = false; this._keys.clear(); this._refresh(); }
      this.onLockChange?.(this.locked);
    });
  }

  _refresh() {
    const has = (codes) => codes.some((c) => this._keys.has(c));
    this.forward = has(this._codeFor('forward'));
    this.back = has(this._codeFor('back'));
    this.left = has(this._codeFor('left'));
    this.right = has(this._codeFor('right'));
    this.sprint = this._keys.has('ShiftLeft') || this._keys.has('ShiftRight');
    this.crouch = this._keys.has('KeyC') || this._keys.has('ControlLeft') || this._keys.has('ControlRight');
  }

  requestLock() {
    if (!this.locked) this.canvas.requestPointerLock?.();
  }

  /** Consomme le mouvement souris accumule depuis la derniere frame. */
  takeMouse() {
    const m = { dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return m;
  }

  consumeJump() { const v = this._jump; this._jump = false; return v; }
  consumeReload() { const v = this._reload; this._reload = false; return v; }
  consumeGrenade() { const v = this._grenade; this._grenade = false; return v; }
  consumeInspect() { const v = this._inspect; this._inspect = false; return v; }
  consumeFire() { const v = this._fireTap; this._fireTap = false; return v; }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
  }
}
