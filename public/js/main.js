/**
 * EasyRanked :: point d'entree et boucle de jeu.
 *
 * Assemble le lobby, le moteur, l'arene, le controleur et le reseau.
 * Deux modes partagent exactement le meme code de jeu :
 *   - entrainement  : simulation locale (bots.js)
 *   - multijoueur   : le serveur PHP fait autorite (net.js)
 */
import * as THREE from 'three';
import { Engine } from './engine.js';
import { Arena } from './arena.js';
import { Physics, PLAYER } from './physics.js';
import { PlayerController, Input } from './player.js';
import { Hud } from './hud.js';
import { NetClient } from './net.js';
import { LocalMatch, resolveWeapon } from './bots.js';
import { Avatar } from './avatars.js';
import { Lobby, Api } from './lobby.js';
import { material, sprite } from './textures.js';

/* --------------------------------------------------- compatibilite canvas */

/**
 * `roundRect` n'existe que depuis Chrome 99 / Firefox 112 / Safari 16.4.
 * Le HUD et les plaques de nom l'utilisent : sans repli, un navigateur un peu
 * ancien ferait echouer tout le dessin de l'interface.
 */
if (typeof CanvasRenderingContext2D !== 'undefined'
    && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const radius = Math.min(Array.isArray(r) ? r[0] : (r || 0), Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + radius, y);
    this.lineTo(x + w - radius, y);
    this.quadraticCurveTo(x + w, y, x + w, y + radius);
    this.lineTo(x + w, y + h - radius);
    this.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    this.lineTo(x + radius, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - radius);
    this.lineTo(x, y + radius);
    this.quadraticCurveTo(x, y, x + radius, y);
    return this;
  };
}

/* ------------------------------------------------------------ chargement */

const loadingEl = document.getElementById('loading');
const loadingText = document.getElementById('loadingText');
const setLoading = (txt) => {
  if (loadingText) loadingText.textContent = txt;
};

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url} : ${res.status}`);
  return res.json();
}

/* ------------------------------------------------------------------ jeu */

class Game {
  constructor({ arenaData, weaponsCfg, canvas, hudRoot }) {
    this.arenaData = arenaData;
    this.cfg = weaponsCfg;
    this.canvas = canvas;
    this.hud = new Hud(hudRoot);
    this.engine = new Engine(canvas, { arena: arenaData, quality: 'high' });
    this.arena = new Arena(arenaData, this.engine.scene);
    this.physics = new Physics(this.arena.colliders, arenaData.bounds);
    this.input = new Input(canvas, { sensitivity: readSensitivity(), layout: 'azerty' });

    this.avatars = new Map();
    this.grenades = [];
    this.running = false;
    this.paused = false;
    this.showScoreboard = false;
    this.net = null;
    this.local = null;
    this.you = 'you';
    this.lastFrame = performance.now() / 1000;
    this.accumulator = 0;
    this.respawnAt = 0;
    this.matchOver = null;

    this.input.onEscape = () => this.togglePause();
    this.input.onLockChange = (locked) => {
      if (!locked && this.running && !this.matchOver) this.setPaused(true);
    };

    window.addEventListener('keydown', (e) => {
      if (!this.running) return;
      if (e.code === 'Tab') { e.preventDefault(); this.showScoreboard = true; }
      if (e.code === 'F3') { e.preventDefault(); this.hud.showPerf = !this.hud.showPerf; }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') this.showScoreboard = false;
    });

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ---------------------------------------------------- demarrage partie */

  /** @param {object} opts  cf. Lobby.onPlay */
  async start(opts, user) {
    this.opts = opts;
    this.user = user;
    this.matchOver = null;
    this.score = [0, 0];
    this.timeLeft = this.cfg.modes[opts.mode].timeLimit;

    const stats = opts.stats || resolveWeapon(this.cfg, opts.loadout.weapon, opts.loadout.attachments);
    const camo = this.cfg.camos.find((c) => c.id === opts.loadout.camo) || null;

    this.player = new PlayerController({
      engine: this.engine,
      physics: this.physics,
      input: this.input,
      balance: this.cfg.balance,
      weaponCfg: stats,
      camo,
      attachments: opts.loadout.attachments,
      grenades: this.cfg.grenades.count,
    });
    this._wirePlayer();

    this.hud.setIdentity({ name: user.username, level: user.level, team: 0 });
    this.hud.setWeapon(stats, opts.loadout.attachments);
    this.hud.setVisible(true);

    if (opts.online) {
      await this._startOnline(opts, user);
    } else {
      this._startOffline(opts, user);
    }

    this.running = true;
    this.setPaused(false);
    this.input.requestLock();
    this.hud.centerMessage(
      opts.online ? `MULTIJOUEUR ${opts.mode.toUpperCase()}` : `ENTRAINEMENT ${opts.mode.toUpperCase()}`,
      2200
    );
  }

  _startOffline(opts, user) {
    this.net = null;
    this.local = new LocalMatch({
      arena: this.arena,
      physics: this.physics,
      weaponsCfg: this.cfg,
      mode: opts.mode,
      botSkill: opts.skill,
      player: this.player,
      playerName: user.username,
      playerLevel: user.level,
    });
    this.you = 'you';
    this.player.team = 0;
    this.local.on('event', (e) => this._onEvent(e));
    this._syncRoster(this.local.roster());
    this.player.teleport(this.arena.spawn(0, 0));
  }

  async _startOnline(opts, user) {
    this.local = null;
    const net = new NetClient();
    this.net = net;
    net.on('event', (e) => this._onEvent(e));
    net.on('close', () => {
      if (this.running && !this.matchOver) {
        this.hud.centerMessage('CONNEXION PERDUE', 4000);
        this.setPaused(true);
      }
    });
    net.on('error', (m) => this.hud.centerMessage((m.msg || 'ERREUR').toUpperCase(), 3000));

    const welcome = await net.connect(opts.server, {
      token: Api.token || undefined,
      name: user.guest ? user.username : undefined,
      mode: opts.mode,
      bots: opts.bots,
      skill: opts.skill,
      slot: opts.slot,
    });

    this.you = welcome.you;
    this.player.team = welcome.team;
    this.hud.setIdentity({ name: user.username, level: welcome.level, team: welcome.team });
    // Le serveur impose la classe assainie : on reconstruit l'arme avec.
    if (welcome.stats) {
      const camo = this.cfg.camos.find((c) => c.id === welcome.loadout?.camo) || null;
      this.player.weapon.setWeapon(welcome.stats, camo, welcome.loadout?.attachments || {});
      this.hud.setWeapon(welcome.stats, welcome.loadout?.attachments || {});
    }
    this._syncRoster(welcome.roster);
    this.player.teleport(new THREE.Vector3(welcome.spawn[0], 0, welcome.spawn[2]));
  }

  _wirePlayer() {
    this.player.onShoot = (origin, dir) => this._fire(origin, dir);
    this.player.onReload = () => this.net?.sendReload();
    this.player.onGrenade = (origin, dir) => this._throwGrenade(origin, dir);
  }

  /* ------------------------------------------------------------- tirs */

  _fire(origin, dir) {
    const w = this.player.weapon;
    // Le modele d'arme vit dans sa propre scene (camera dediee) : son bout de
    // canon n'a pas de position monde utilisable. On place donc le flash et le
    // depart de traceuse sur l'axe de visee, a la distance du canon.
    const worldMuzzle = origin.clone().addScaledVector(dir, 0.55)
      .add(new THREE.Vector3(0, -0.06, 0));
    this.engine.spawnFlash(worldMuzzle, w.cfg.silent ? 0.2 : 0.46);

    if (this.net) {
      // En ligne : le serveur tranche. On affiche l'impact predit immediatement
      // (reactivite) ; les degats, eux, viennent de l'evenement serveur.
      this.net.sendShot(origin, dir);
      const hit = this.physics.raycast(origin, dir, 240);
      const end = hit ? hit.point : origin.clone().addScaledVector(dir, 120);
      this.engine.spawnTracer(worldMuzzle, end);
      if (hit) this.engine.spawnImpact(hit.point, hit.normal, hit.mat);
    } else {
      const res = this.local.playerShoot(origin, dir, this.now);
      this.engine.spawnTracer(worldMuzzle, res.impact);
      if (res.hit) {
        this.engine.spawnImpact(res.impact, res.normal, 'flesh');
        this.hud.hit(res.hit.killed ? 'kill' : 'hit');
      } else if (res.mat !== 'air') {
        this.engine.spawnImpact(res.impact, res.normal, res.mat);
      }
    }
  }

  _throwGrenade(origin, dir) {
    const g = this.cfg.grenades;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 10, 8),
      material('polymer', { repeat: [1, 1] })
    );
    mesh.castShadow = true;
    mesh.position.copy(origin).addScaledVector(dir, 0.4);
    this.engine.scene.add(mesh);
    this.grenades.push({
      mesh,
      vel: dir.clone().multiplyScalar(g.throwSpeed).add(new THREE.Vector3(0, 2, 0)),
      fuse: g.fuse,
      by: this.you,
    });
    this.net?.sendGrenade(dir);
  }

  _updateGrenades(dt) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const gr = this.grenades[i];
      gr.fuse -= dt;

      // Integration + rebonds sur le monde (meme modele que le serveur).
      const step = gr.vel.clone().multiplyScalar(dt);
      const len = step.length();
      if (len > 1e-5) {
        const dir = step.clone().divideScalar(len);
        const hit = this.physics.raycast(gr.mesh.position, dir, len + 0.06);
        if (hit) {
          gr.mesh.position.copy(hit.point).addScaledVector(hit.normal, 0.06);
          gr.vel.reflect(hit.normal).multiplyScalar(0.42);
        } else {
          gr.mesh.position.add(step);
        }
      }
      gr.vel.y -= 19.6 * dt;
      if (gr.mesh.position.y < 0.055) {
        gr.mesh.position.y = 0.055;
        gr.vel.y = Math.abs(gr.vel.y) * 0.3;
        gr.vel.x *= 0.62;
        gr.vel.z *= 0.62;
        if (Math.abs(gr.vel.y) < 0.6) gr.vel.y = 0;
      }
      gr.mesh.rotation.x += dt * 6;
      gr.mesh.rotation.z += dt * 4;

      if (gr.fuse <= 0) {
        const at = gr.mesh.position.clone();
        this.engine.scene.remove(gr.mesh);
        gr.mesh.geometry.dispose();
        this.grenades.splice(i, 1);
        this.engine.spawnExplosion(at);
        // Secousse d'ecran proportionnelle a la distance.
        const d = at.distanceTo(this.player.pos);
        this.player.shake = Math.max(this.player.shake, Math.max(0, 1 - d / 16) * 0.9);
        // Hors ligne, c'est le client qui applique les degats.
        if (this.local) this.local.explode(at, gr.by, this.now);
      }
    }
  }

  /* ---------------------------------------------------------- evenements */

  _onEvent(e) {
    switch (e.t) {
      case 'join':
        this._ensureAvatar(e.player);
        break;

      case 'leave': {
        const av = this.avatars.get(e.id);
        if (av) { av.dispose(); this.avatars.delete(e.id); }
        break;
      }

      case 'shot': {
        if (e.id === this.you) break;      // deja rendu localement
        const o = toVec(e.o), p = toVec(e.p);
        const av = this.avatars.get(e.id);
        if (av) av.firingUntil = this.now + 0.09;
        const from = av ? av.muzzleWorld() : o;
        this.engine.spawnTracer(from, p);
        if (!e.silent) this.engine.spawnFlash(from, 0.4);
        if (!e.hit) {
          // On retrouve la normale du mur pour orienter l'impact.
          const dir = p.clone().sub(o).normalize();
          const hit = this.physics.raycast(o, dir, o.distanceTo(p) + 0.3);
          if (hit) this.engine.spawnImpact(hit.point, hit.normal, hit.mat);
        }
        break;
      }

      case 'dmg': {
        const pos = toVec(e.pos);
        if (e.by === this.you) {
          this.hud.hit(e.kill ? 'kill' : 'hit');
          if (e.zone !== 'blast') {
            this.engine.spawnImpact(pos, new THREE.Vector3(0, 1, 0), 'flesh');
          }
        }
        if (e.on === this.you) {
          if (this.net) {
            // Autorite serveur : la vie affichee vient de lui.
            this.player.health = e.hp;
            this.player.shake = Math.max(this.player.shake, Math.min(0.8, e.amount / 60));
            if (e.hp <= 0) this.player.alive = false;
          }
          const src = this.avatars.get(e.by);
          if (src) {
            const dx = src.root.position.x - this.player.pos.x;
            const dz = src.root.position.z - this.player.pos.z;
            this.hud.damageFrom(Math.atan2(dx, -dz) - this.player.yaw);
          }
        }
        break;
      }

      case 'kill': {
        const killer = this._nameOf(e.by);
        const victim = this._nameOf(e.on);
        this.hud.addKill({
          killer, victim, headshot: !!e.headshot,
          killerTeam: this._teamOf(e.by), victimTeam: this._teamOf(e.on),
          youKiller: e.by === this.you, youVictim: e.on === this.you,
        });
        if (e.score) this.score = e.score;
        if (e.on === this.you) {
          this.player.alive = false;
          this.respawnAt = this.now + (e.respawnIn ?? this.cfg.balance.respawnDelay);
          this.hud.centerMessage(`ELIMINE PAR ${killer.toUpperCase()}`, 2600);
        } else if (e.by === this.you) {
          this.hud.centerMessage(e.headshot ? 'TIR A LA TETE' : 'ELIMINATION', 900);
        }
        break;
      }

      case 'spawn':
        if (e.id === this.you && e.pos) {
          this.player.respawn(new THREE.Vector3(e.pos[0], 0, e.pos[2]));
          this.hud.centerMessage('', 0);
        }
        break;

      case 'correct':
        // Recalage autoritaire (desynchronisation ou triche detectee).
        if (e.id === this.you) this.player.teleport(new THREE.Vector3(e.pos[0], e.pos[1], e.pos[2]));
        break;

      case 'reload':
        if (e.id === this.you && this.net) {
          this.player.weapon.reloading = true;
          this.player.weapon.reloadStart = this.now;
          this.player.weapon.reloadEnd = this.now + e.done;
        }
        break;

      case 'nade':
        if (e.by !== this.you) {
          const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(0.055, 10, 8),
            material('polymer', { repeat: [1, 1] })
          );
          mesh.position.copy(toVec(e.o));
          this.engine.scene.add(mesh);
          this.grenades.push({
            mesh,
            vel: toVec(e.d).multiplyScalar(this.cfg.grenades.throwSpeed).add(new THREE.Vector3(0, 2, 0)),
            fuse: e.fuse,
            by: e.by,
            remote: true,
          });
        }
        break;

      case 'blast':
        if (e.at) this.engine.spawnExplosion(toVec(e.at));
        break;

      case 'start':
        this.hud.centerMessage('COMBAT', 1500);
        break;

      case 'chat':
        this.hud.chat(e.from, e.msg, e.team);
        break;

      case 'end':
        this._endMatch(e);
        break;
    }
  }

  _endMatch(e) {
    this.matchOver = e;
    const you = (e.summary || []).find((r) => r.id === this.you || r.id === 'you');
    const won = e.winner === this.player.team;
    this.hud.centerMessage(e.winner < 0 ? 'EGALITE' : (won ? 'VICTOIRE' : 'DEFAITE'), 0);
    if (you?.progression) this.onProgression?.(you.progression);
    document.exitPointerLock?.();
    this.onMatchEnd?.(e, you);
  }

  _nameOf(id) {
    if (id === this.you) return this.user?.username || 'Vous';
    return this.avatars.get(id)?.info.name || this.net?.nameOf(id) || 'Inconnu';
  }

  _teamOf(id) {
    if (id === this.you) return this.player.team;
    return this.avatars.get(id)?.info.team ?? this.net?.teamOf(id) ?? 0;
  }

  _syncRoster(roster) {
    for (const p of roster || []) {
      if (p.id === this.you) continue;
      this._ensureAvatar(p);
    }
  }

  _ensureAvatar(info) {
    if (info.id === this.you || this.avatars.has(info.id)) return;
    const av = new Avatar(info, {
      scene: this.engine.scene,
      camos: this.cfg.camos,
      weapons: this.cfg.weapons,
    });
    this.avatars.set(info.id, av);
  }

  /* --------------------------------------------------------- boucle */

  _loop(tms) {
    requestAnimationFrame(this._loop);
    const t = tms / 1000;
    let dt = t - this.lastFrame;
    this.lastFrame = t;
    this.now = t;
    // Garde-fou : un onglet en arriere-plan ne doit pas produire un pas geant.
    dt = Math.min(dt, 0.1);

    if (!this.running) {
      this.engine.render(dt);
      return;
    }

    if (!this.paused) {
      this._step(dt, t);
    } else {
      // En pause on continue de rendre (l'arme et la scene restent visibles).
      this.engine.updateParticles(dt * 0.2);
    }

    this.engine.followShadow(this.player.pos);
    this.engine.render(dt);

    const stats = this.engine.stats();
    stats.ping = this.net?.ping ?? 0;
    this.hud.setPerf(stats);
  }

  _step(dt, t) {
    // --- souris
    const m = this.input.takeMouse();
    if (m.dx || m.dy) this.player.applyMouse(m.dx, m.dy, this.input.sensitivity);

    // --- simulation
    this.player.update(dt, t);
    // Hors ligne, personne d'autre ne regenere le joueur ; en ligne les valeurs
    // viennent du serveur et sont ecrasees plus bas.
    if (this.local) { this.player.regen(t, dt); this.local.tick(t, dt); }
    this._updateGrenades(dt);
    this.engine.updateParticles(dt);

    // --- respawn
    if (!this.player.alive && this.respawnAt > 0 && t >= this.respawnAt) {
      this.respawnAt = 0;
      if (this.local) {
        this.local.respawnPlayer(t);
        this.hud.centerMessage('', 0);
      }
      // En ligne, c'est l'evenement 'spawn' du serveur qui fait foi.
    }

    // --- reseau
    if (this.net) {
      this.net.sendInput(this.player, t);
      const me = this.net.buffer.length
        ? this.net.buffer[this.net.buffer.length - 1].players.get(this.you)
        : null;
      if (me) {
        // Reconciliation douce : vie, munitions et etat de rechargement sont
        // autoritaires ; la position reste predite localement.
        this.player.health = me.health;
        this.player.shield = me.shield;
        this.player.weapon.syncFromServer(me.ammo, me.reloading);
        if (me.alive && !this.player.alive) this.player.alive = true;
      }
      if (this.net.score) this.score = this.net.score;
      this.timeLeft = this.net.timeLeft ?? this.timeLeft;
    } else if (this.local) {
      this.score = this.local.score;
      this.timeLeft = this.local.timeLeft;
    }

    // --- avatars
    const snapshot = this.net ? this.net.interpolated() : this.local.interpolated();
    const camPos = this.engine.camera.position;
    for (const [id, s] of snapshot) {
      if (id === this.you) continue;
      let av = this.avatars.get(id);
      if (!av) {
        const info = this.net?.playerInfo(id) || { id, name: id, team: 1 };
        this._ensureAvatar(info);
        av = this.avatars.get(id);
        if (!av) continue;
      }
      s.firing = this.now < (av.firingUntil ?? 0);
      av.update(s, dt, camPos, av.info.team === this.player.team);
    }

    // --- HUD
    const w = this.player.weapon;
    const bal = this.cfg.balance;
    this.hud.setVitals(this.player.health, bal.maxHealth, this.player.shield, bal.shieldMax);
    this.hud.setAmmo(w.ammo, w.cfg.magazine, w.reserve, w.reloading);
    this.hud.setGrenades(w.grenades);
    this.hud.setScore(this.score[0], this.score[1], this.timeLeft);

    const moving = Math.hypot(this.player.vel.x, this.player.vel.z) > 1.4 || !this.player.grounded;
    const spread = (w.ads > 0.5 ? w.cfg.spreadAds : w.cfg.spreadHip)
      * (1 + Math.min(1.8, w.shotsFired * 0.055)) * (moving ? w.cfg.spreadMoveMul : 1);
    this.hud.setCrosshair(
      spread, w.ads, this.player.weapon.model.userData.hasScope,
      this.engine.camera.fov, this.canvas.clientHeight || window.innerHeight
    );

    if (this.showScoreboard !== this._sbShown || this.showScoreboard) {
      this._sbShown = this.showScoreboard;
      const rows = this.showScoreboard
        ? (this.local ? this.local.scoreboard('you')
                      : buildNetScoreboard(this.net, this.you, this.user?.username))
        : [];
      this.hud.setScoreboard(rows, this.showScoreboard, `${this.opts.mode.toUpperCase()} — FOUNDRY`);
    }
  }

  /* ------------------------------------------------------------ pause */

  togglePause() {
    if (!this.running) return;
    this.setPaused(!this.paused);
  }

  setPaused(p) {
    this.paused = p;
    document.getElementById('pauseMenu').dataset.on = p ? '1' : '0';
    if (!p) this.input.requestLock();
    else document.exitPointerLock?.();
  }

  stop() {
    this.running = false;
    this.paused = false;
    this.hud.setVisible(false);
    document.getElementById('pauseMenu').dataset.on = '0';
    document.exitPointerLock?.();
    for (const av of this.avatars.values()) av.dispose();
    this.avatars.clear();
    for (const gr of this.grenades) this.engine.scene.remove(gr.mesh);
    this.grenades.length = 0;
    this.player?.weapon.dispose();
    this.net?.disconnect();
    this.net = null;
    this.local = null;
  }
}

/* --------------------------------------------------------- utilitaires */

function toVec(a) {
  if (!a) return new THREE.Vector3();
  if (a.isVector3) return a.clone();
  return new THREE.Vector3(a[0], a[1], a[2]);
}

function buildNetScoreboard(net, youId, youName) {
  if (!net) return [];
  const last = net.buffer.length ? net.buffer[net.buffer.length - 1].players : new Map();
  const rows = [];
  for (const [id, info] of net.roster) {
    const s = last.get(id);
    rows.push({
      name: id === youId ? (youName || info.name) : info.name,
      team: info.team, bot: info.bot,
      kills: s?.kills ?? 0, deaths: s?.deaths ?? 0, damage: 0,
      you: id === youId,
    });
  }
  return rows;
}

function readSensitivity() {
  const v = parseFloat(localStorage.getItem('er_sens') || '1');
  return Number.isFinite(v) && v > 0.05 ? v : 1;
}

/* --------------------------------------------------------------- boot */

async function boot() {
  try {
    setLoading('Chargement de la configuration...');
    const [arenaData, weaponsCfg] = await Promise.all([
      fetchJson('./shared/arena.json').catch(() => fetchJson('./api/shared.php?f=arena')),
      fetchJson('./shared/weapons.json').catch(() => fetchJson('./api/shared.php?f=weapons')),
    ]);

    setLoading('Generation des textures et des modeles...');
    // Un tick de rendu laisse le navigateur peindre l'ecran de chargement.
    await new Promise((r) => setTimeout(r, 16));

    const canvas = document.getElementById('game');
    const game = new Game({
      arenaData, weaponsCfg,
      canvas,
      hudRoot: document.getElementById('hudRoot'),
    });

    setLoading('Arene prete.');
    const lobby = new Lobby(document.getElementById('lobbyRoot'), weaponsCfg);
    game.onProgression = (p) => lobby.applyProgression(p);
    game.onMatchEnd = (e, you) => showResults(e, you, game, lobby);

    lobby.onPlay = async (opts) => {
      lobby.setHint('');
      try {
        lobby.hide();
        await game.start(opts, lobby.user);
      } catch (err) {
        lobby.show();
        game.stop();
        lobby.setHint(err.message);
      }
    };

    document.getElementById('resumeBtn').onclick = () => game.setPaused(false);
    document.getElementById('quitBtn').onclick = () => {
      game.stop();
      lobby.show();
    };
    const sens = document.getElementById('sensRange');
    sens.value = String(readSensitivity());
    document.getElementById('sensValue').textContent = sens.value;
    sens.oninput = () => {
      game.input.sensitivity = +sens.value;
      document.getElementById('sensValue').textContent = sens.value;
      localStorage.setItem('er_sens', sens.value);
    };

    const restored = await lobby.tryRestore();
    if (!restored) lobby.el.auth.hidden = false;
    lobby.show();
    loadingEl.dataset.on = '0';

    window.__easyranked = { game, lobby };
  } catch (err) {
    setLoading('Erreur : ' + err.message);
    console.error(err);
    loadingEl.dataset.error = '1';
  }
}

function showResults(e, you, game, lobby) {
  const panel = document.getElementById('results');
  const winner = e.winner < 0 ? 'EGALITE' : (e.winner === game.player.team ? 'VICTOIRE' : 'DEFAITE');
  panel.innerHTML = `
    <div class="res-card">
      <h2 data-outcome="${e.winner < 0 ? 'draw' : (e.winner === game.player.team ? 'win' : 'loss')}">${winner}</h2>
      <div class="res-score">${e.score[0]} &ndash; ${e.score[1]}</div>
      ${you ? `<div class="res-you">
        <span><i>Eliminations</i><b>${you.kills}</b></span>
        <span><i>Morts</i><b>${you.deaths}</b></span>
        <span><i>Degats</i><b>${you.damage}</b></span>
        ${you.xp ? `<span><i>XP gagnee</i><b>+${you.xp}</b></span>` : ''}
      </div>` : ''}
      ${you?.progression ? `<div class="res-level">Niveau ${you.progression.level}
        ${you.progression.levelsGained > 0 ? `<em>+${you.progression.levelsGained}</em>` : ''}</div>` : ''}
      <table class="res-table">
        <thead><tr><th>Operateur</th><th>Eq.</th><th>E</th><th>M</th><th>Deg.</th></tr></thead>
        <tbody>${(e.summary || []).map((r) => `
          <tr data-you="${(r.id === game.you || r.id === 'you') ? '1' : '0'}">
            <td>${escapeHtml(r.name)}${r.bot ? ' <i>BOT</i>' : ''}</td>
            <td>${r.team === 1 ? 'B' : 'A'}</td>
            <td>${r.kills}</td><td>${r.deaths}</td><td>${r.damage}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn btn-primary" id="resBack">Retour au lobby</button>
    </div>`;
  panel.dataset.on = '1';
  document.getElementById('resBack').onclick = () => {
    panel.dataset.on = '0';
    game.stop();
    lobby.show();
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

boot();
