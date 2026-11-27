/**
 * EasyRanked :: partie locale contre des bots (mode entrainement, sans serveur).
 *
 * Reprend la logique de server/src/Bot.php cote client : navigation A* sur les
 * memes waypoints, prise de couverture, dispersion et temps de reaction. Permet
 * de jouer meme si le serveur WebSocket PHP n'est pas lance.
 */
import * as THREE from 'three';
import { rayPlayer } from './physics.js';

const BOT_NAMES = ['Volkov', 'Reaper', 'Kilo', 'Nomad', 'Wraith', 'Dusk', 'Ronin', 'Falco',
                   'Mirage', 'Tundra', 'Vega', 'Hawk', 'Zulu', 'Orion', 'Baron', 'Specter'];

/* ----------------------------------------------------- graphe de navigation */

export class NavGraph {
  constructor(waypoints) {
    this.nodes = waypoints;
    this.cell = 6;
    this.grid = new Map();
    this.nodes.forEach((n, i) => {
      const k = `${Math.floor(n.p[0] / this.cell)}:${Math.floor(n.p[2] / this.cell)}`;
      (this.grid.get(k) || this.grid.set(k, []).get(k)).push(i);
    });
    // Tampons reutilises par A* : aucune allocation par appel.
    this._g = new Float64Array(this.nodes.length);
    this._f = new Float64Array(this.nodes.length);
    this._came = new Int32Array(this.nodes.length);
    this._closed = new Uint8Array(this.nodes.length);
    this._stamp = new Int32Array(this.nodes.length);
    this._epoch = 0;
  }

  nearest(pos) {
    let best = -1, bestD = Infinity;
    const cx = Math.floor(pos.x / this.cell), cz = Math.floor(pos.z / this.cell);
    for (let r = 1; r <= 4; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          for (const i of this.grid.get(`${cx + dx}:${cz + dz}`) || []) {
            const p = this.nodes[i].p;
            const d = (p[0] - pos.x) ** 2 + (p[2] - pos.z) ** 2;
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best >= 0) break;
    }
    if (best < 0) {
      this.nodes.forEach((n, i) => {
        const d = (n.p[0] - pos.x) ** 2 + (n.p[2] - pos.z) ** 2;
        if (d < bestD) { bestD = d; best = i; }
      });
    }
    return Math.max(0, best);
  }

  /** A* avec file triee par insertion (les frontieres restent petites). */
  path(from, to) {
    if (from === to || from < 0 || to < 0) return [];
    const { nodes, _g: g, _f: f, _came: came, _closed: closed, _stamp: stamp } = this;
    const epoch = ++this._epoch;
    const goal = nodes[to].p;
    const open = [from];
    g[from] = 0;
    f[from] = this._h(from, goal);
    came[from] = -1;
    stamp[from] = epoch;
    closed[from] = 0;

    while (open.length) {
      // Extraction du minimum.
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
      const cur = open.splice(bi, 1)[0];
      if (cur === to) break;
      closed[cur] = 1;

      for (const nb of nodes[cur].n) {
        if (stamp[nb] === epoch && closed[nb]) continue;
        const a = nodes[cur].p, b = nodes[nb].p;
        const step = Math.hypot(a[0] - b[0], a[2] - b[2]);
        const tentative = g[cur] + step;
        if (stamp[nb] !== epoch) {
          stamp[nb] = epoch; closed[nb] = 0; g[nb] = Infinity; came[nb] = -1;
        }
        if (tentative < g[nb] - 1e-6) {
          g[nb] = tentative;
          came[nb] = cur;
          f[nb] = tentative + this._h(nb, goal);
          if (!open.includes(nb)) open.push(nb);
        }
      }
    }

    if (stamp[to] !== epoch || (came[to] === -1 && to !== from)) return [];
    const out = [];
    for (let k = to; k !== -1 && k !== from; k = came[k]) {
      out.unshift(k);
      if (out.length > nodes.length) return [];
    }
    return out;
  }

  _h(i, goal) {
    const p = this.nodes[i].p;
    return Math.hypot(p[0] - goal[0], p[2] - goal[2]);
  }

  coverNear(pos, threat, physics, radius = 18) {
    let best = -1, bestScore = -Infinity;
    const eye = new THREE.Vector3();
    for (let i = 0; i < this.nodes.length; i++) {
      const nd = this.nodes[i];
      if (!nd.cover) continue;
      const d = Math.hypot(nd.p[0] - pos.x, nd.p[2] - pos.z);
      if (d > radius) continue;
      eye.set(nd.p[0], 1.0, nd.p[2]);
      const hidden = physics.lineOfSight(eye, threat) ? 0 : 1;
      const dT = Math.hypot(nd.p[0] - threat.x, nd.p[2] - threat.z);
      const score = hidden * 9 + nd.cover * 1.6 - d * 0.32 + Math.min(dT, 26) * 0.1;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  random() { return (Math.random() * this.nodes.length) | 0; }
}

/* ------------------------------------------------------------------ bot */

export class LocalBot {
  constructor(id, name, team, stats, skill, nav, physics) {
    this.id = id;
    this.name = name;
    this.team = team;
    this.stats = stats;
    this.skill = Math.max(0, Math.min(1, skill));
    this.nav = nav;
    this.physics = physics;
    this.isBot = true;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.stance = 1;
    this.alive = true;
    // Les bots ont une reserve unique equivalente au total du joueur
    // (points de vie + bouclier) : meme nombre de balles pour les abattre.
    this.maxHealth = 150;
    this.health = this.maxHealth;
    this.shield = 0;
    this.kills = 0;
    this.deaths = 0;
    this.damage = 0;
    this.ammo = stats.magazine;
    this.reserve = stats.reserve;
    this.reloading = false;
    this.reloadEnd = 0;
    this.nextShot = 0;
    this.lastShotAt = -99;
    this.respawnAt = 0;
    this.sprinting = false;
    this.ads = false;

    this.state = 'patrol';
    this.path = [];
    this.goal = -1;
    this.repathAt = 0;
    this.target = null;
    this.targetSeenAt = -99;
    this.lastKnown = new THREE.Vector3();
    this.reactionUntil = 0;
    this.burstUntil = 0;
    this.burstPause = 0;
    this.strafeDir = 1;
    this.strafeFlip = 0;
    this.jitter = [0, 0];
    this.jitterAt = 0;
  }

  spawnAt(v, now) {
    this.pos.copy(v);
    this.vel.set(0, 0, 0);
    this.alive = true;
    this.health = this.maxHealth;
    this.ammo = this.stats.magazine;
    this.reserve = this.stats.reserve;
    this.reloading = false;
    this.path = [];
    this.goal = -1;
    this.repathAt = 0;
    this.target = null;
    this.protectedUntil = now + 1.2;
  }

  eye(out = new THREE.Vector3()) {
    return out.set(this.pos.x, this.pos.y + 1.62 * this.stance, this.pos.z);
  }

  /** @param {object} world { now, dt, combatants, physics, onShoot } */
  tick(world) {
    if (!this.alive) return;
    const { now, dt } = world;

    if (this.reloading && now >= this.reloadEnd) {
      const take = Math.min(this.stats.magazine - this.ammo, this.reserve);
      this.ammo += take;
      this.reserve -= take;
      if (this.reserve <= 0) this.reserve = this.stats.reserve;   // les bots ne restent pas a sec
      this.reloading = false;
    }

    this._perceive(world);
    this._decide(world);
    this._navigate(world);
    this._aimAndFire(world);
  }

  _perceive(world) {
    const { now, combatants, physics } = world;
    const eye = this.eye();
    let best = null, bestScore = -Infinity;
    const tgt = new THREE.Vector3();

    for (const c of combatants) {
      if (c === this || c.team === this.team || !c.alive) continue;
      tgt.set(c.pos.x, c.pos.y + 1.25 * (c.stance ?? 1), c.pos.z);
      const dist = eye.distanceTo(tgt);
      if (dist > 70) continue;
      const dx = tgt.x - eye.x, dz = tgt.z - eye.z;
      const fx = Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const dot = (dx * fx + dz * fz) / Math.max(1e-4, Math.hypot(dx, dz));
      const audible = dist < 11 && now - (c.lastShotAt ?? -99) < 1.4;
      if (dot < -0.34 && !audible) continue;
      if (!physics.lineOfSight(eye, tgt)) continue;
      const score = 100 - dist + (c === this.target ? 14 : 0) + (c.health < 60 ? 18 : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }

    if (best) {
      if (best !== this.target) {
        this.reactionUntil = now + (0.32 - 0.21 * this.skill);
        this.target = best;
      }
      this.targetSeenAt = now;
      this.lastKnown.copy(best.pos);
    } else if (now - this.targetSeenAt > 2.6) {
      this.target = null;
    }
  }

  _decide(world) {
    const { now, physics } = world;
    const visible = this.target && now - this.targetSeenAt < 0.35;
    const low = this.health < 60 || this.ammo === 0;

    const next = low && (visible || now - this.targetSeenAt < 2)
      ? 'cover'
      : visible ? 'engage' : this.target ? 'hunt' : 'patrol';
    if (next !== this.state) { this.state = next; this.repathAt = 0; }

    if (now < this.repathAt && this.path.length) return;
    this.repathAt = now + 0.6 + (1 - this.skill) * 0.5;

    const from = this.nav.nearest(this.pos);
    let goal;
    if (this.state === 'cover') goal = this.nav.coverNear(this.pos, this.lastKnown, physics, 18);
    else if (this.state === 'engage') goal = this._engagementNode(physics);
    else if (this.state === 'hunt') goal = this.nav.nearest(this.lastKnown);
    else goal = this._patrolNode();
    if (goal < 0) goal = this.nav.random();

    if (goal !== this.goal || this.path.length === 0) {
      this.goal = goal;
      this.path = this.nav.path(from, goal);
    }
  }

  _engagementNode(physics) {
    const ideal = Math.min(28, Math.max(7, this.stats.rangeFull * 0.55));
    let best = -1, bestScore = -Infinity;
    const eye = new THREE.Vector3();
    const tgt = new THREE.Vector3(this.lastKnown.x, this.lastKnown.y + 1.25, this.lastKnown.z);
    for (let i = 0; i < this.nav.nodes.length; i++) {
      const nd = this.nav.nodes[i];
      const dSelf = Math.hypot(nd.p[0] - this.pos.x, nd.p[2] - this.pos.z);
      if (dSelf > 14) continue;
      const dT = Math.hypot(nd.p[0] - tgt.x, nd.p[2] - tgt.z);
      eye.set(nd.p[0], 1.55, nd.p[2]);
      const shootable = physics.lineOfSight(eye, tgt) ? 1 : 0;
      const score = shootable * 6 - Math.abs(dT - ideal) * 0.5 + nd.cover * 1.1 - dSelf * 0.12;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  _patrolNode() {
    for (let i = 0; i < 8; i++) {
      const c = this.nav.random();
      const p = this.nav.nodes[c].p;
      if (Math.hypot(p[0] - this.pos.x, p[2] - this.pos.z) > 12) return c;
    }
    return this.nav.random();
  }

  _navigate(world) {
    const { dt, now } = world;
    let speed = 5.9 * this.stats.mobility;
    this.sprinting = this.state === 'patrol';
    if (this.sprinting) speed *= 1.1;
    if (this.state === 'cover') speed *= 1.14;

    if (this.path.length === 0) {
      this._strafe(dt, now, speed * 0.55);
      return;
    }
    let node = this.nav.nodes[this.path[0]].p;
    let dx = node[0] - this.pos.x, dz = node[2] - this.pos.z;
    let dist = Math.hypot(dx, dz);
    if (dist < 1.1) {
      this.path.shift();
      if (!this.path.length) return;
      node = this.nav.nodes[this.path[0]].p;
      dx = node[0] - this.pos.x; dz = node[2] - this.pos.z;
      dist = Math.max(1e-4, Math.hypot(dx, dz));
    }
    const step = Math.min(speed * dt, dist);
    this.pos.x += (dx / dist) * step;
    this.pos.z += (dz / dist) * step;
    this.pos.y = this.physics.groundAt(this.pos.x, this.pos.z, 8);
    this.vel.set((dx / dist) * speed, 0, (dz / dist) * speed);
    if (this.state === 'engage') this._strafe(dt, now, speed * 0.4);
  }

  _strafe(dt, now, speed) {
    if (now > this.strafeFlip) {
      this.strafeDir = Math.random() < 0.5 ? 1 : -1;
      this.strafeFlip = now + 0.6 + Math.random() * 1.1;
    }
    const nx = this.pos.x + Math.cos(this.yaw) * this.strafeDir * speed * dt;
    const nz = this.pos.z + Math.sin(this.yaw) * this.strafeDir * speed * dt;
    const probe = new THREE.Vector3(nx, this.pos.y, nz);
    if (!this.physics.overlaps(probe, 1.8)) {
      this.pos.x = nx;
      this.pos.z = nz;
    } else {
      this.strafeFlip = 0;
    }
  }

  _aimAndFire(world) {
    const { now, dt, physics } = world;
    const t = this.target;

    if (!t || !t.alive) {
      if (this.path.length) {
        const n = this.nav.nodes[this.path[0]].p;
        this.yaw = Math.atan2(n[0] - this.pos.x, -(n[2] - this.pos.z));
      }
      this.pitch *= 0.9;
      this.ads = false;
      this._maybeReload(now);
      return;
    }

    const eye = this.eye();
    const lead = 0.085 * this.skill;
    const aim = new THREE.Vector3(
      t.pos.x + (t.vel?.x ?? 0) * lead,
      t.pos.y + (1.25 + 0.26 * this.skill) * (t.stance ?? 1),
      t.pos.z + (t.vel?.z ?? 0) * lead
    );
    const d = aim.clone().sub(eye);
    const dist = Math.max(0.3, d.length());

    if (now > this.jitterAt) {
      this.jitterAt = now + 0.16;
      const amp = (1 - this.skill) * 0.055 + 0.008;
      this.jitter = [(Math.random() * 2 - 1) * amp, (Math.random() * 2 - 1) * amp * 0.6];
    }
    const wantYaw = Math.atan2(d.x, -d.z) + this.jitter[0];
    const wantPitch = Math.asin(THREE.MathUtils.clamp(d.y / dist, -1, 1)) + this.jitter[1];
    const turn = Math.min(1, (4 + 9 * this.skill) * dt);
    this.yaw += wrapAngle(wantYaw - this.yaw) * turn;
    this.pitch += (wantPitch - this.pitch) * turn;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.4, 1.4);
    this.ads = dist > 12;

    if (this._maybeReload(now)) return;
    if (now < this.reactionUntil || now < this.nextShot || this.reloading) return;
    if (!physics.lineOfSight(eye, aim)) return;
    if (now < this.burstPause) return;
    if (now > this.burstUntil) {
      this.burstUntil = now + 0.18 + this.skill * 0.3;
      this.burstPause = 0;
    }

    const fwd = new THREE.Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
    if (d.dot(fwd) / dist < 0.985) return;

    this.ammo--;
    this.nextShot = now + this.stats.fireInterval;
    this.lastShotAt = now;
    const spread = THREE.MathUtils.degToRad(this.spreadDegrees()) * 0.5;
    world.onShoot(this, jitterDir(fwd, spread, this.yaw));

    if (now >= this.burstUntil) {
      this.burstPause = now + 0.12 + (1 - this.skill) * 0.3;
      this.burstUntil = 0;
    }
  }

  _maybeReload(now) {
    if (this.reloading) return true;
    const lowMag = this.ammo <= Math.max(2, this.stats.magazine * 0.12);
    const safe = !this.target || now - this.targetSeenAt > 1.4;
    if (this.ammo === 0 || (lowMag && safe)) {
      this.reloading = true;
      this.reloadEnd = now + (this.ammo === 0 ? this.stats.reloadEmptyTime : this.stats.reloadTime);
      return true;
    }
    return false;
  }

  spreadDegrees() {
    const base = this.ads ? this.stats.spreadAds : this.stats.spreadHip;
    const skillMul = 2.1 - 1.35 * this.skill;
    const moving = Math.hypot(this.vel.x, this.vel.z) > 1 ? 1.25 : 1;
    return base * skillMul * moving;
  }

  takeDamage(amount, from, now) {
    if (!this.alive || now < (this.protectedUntil ?? 0)) return { applied: 0, killed: false };
    const before = this.health;
    this.health = Math.max(0, this.health - amount);
    const applied = before - this.health;
    // Un bot touche se retourne vers son agresseur.
    if (from && from !== this.target) { this.target = from; this.targetSeenAt = now - 0.1; }
    if (from) this.lastKnown.copy(from.pos);
    const killed = this.health <= 0;
    if (killed) { this.alive = false; this.deaths++; }
    return { applied, killed };
  }
}

/* ------------------------------------------------------- partie locale */

/**
 * Orchestre une partie hors ligne : equipes, bots, respawns, score, tirs.
 * L'API est volontairement proche de celle de NetClient pour que main.js
 * traite les deux modes de la meme maniere.
 */
export class LocalMatch {
  constructor({ arena, physics, weaponsCfg, mode, botSkill, player, playerName, playerLevel }) {
    this.arena = arena;
    this.physics = physics;
    this.weaponsCfg = weaponsCfg;
    this.mode = mode;
    this.modeCfg = weaponsCfg.modes[mode] || weaponsCfg.modes['2v2'];
    this.nav = new NavGraph(arena.waypoints());
    this.player = player;
    this.playerName = playerName || 'Vous';
    this.playerLevel = playerLevel || 1;
    this.botSkill = botSkill ?? 0.6;

    this.score = [0, 0];
    this.timeLeft = this.modeCfg.timeLimit;
    this.state = 'live';
    this.bots = [];
    this.events = [];
    this.handlers = {};

    // Le joueur est traite comme un combattant parmi les autres.
    this.playerEntity = {
      id: 'you', name: this.playerName, team: 0, alive: true,
      pos: player.pos, vel: player.vel, stance: 1,
      health: player.health, kills: 0, deaths: 0, damage: 0,
      lastShotAt: -99, isBot: false,
    };

    const size = this.modeCfg.teamSize;
    let n = 0;
    for (let team = 0; team <= 1; team++) {
      const count = team === 0 ? size - 1 : size;
      for (let i = 0; i < count; i++) this._spawnBot(team, n++);
    }
    this.combatants = [this.playerEntity, ...this.bots];
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
  _emit(event, payload) { for (const fn of this.handlers[event] || []) fn(payload); }

  _spawnBot(team, index) {
    const ids = ['mk18', 'mp5', 'ak74', 'mk18'];
    const weaponId = ids[index % ids.length];
    const stats = resolveWeapon(this.weaponsCfg, weaponId, {
      optic: 'reddot', muzzle: 'comp', grip: 'vertical',
    });
    const skill = Math.max(0.05, Math.min(1, this.botSkill + (Math.random() - 0.5) * 0.28));
    const bot = new LocalBot(
      'bot' + index, BOT_NAMES[index % BOT_NAMES.length], team,
      stats, skill, this.nav, this.physics
    );
    bot.maxHealth = this.weaponsCfg.balance.maxHealth + this.weaponsCfg.balance.shieldMax;
    bot.health = bot.maxHealth;
    bot.weaponId = weaponId;
    bot.camoId = ['default', 'woodland', 'urban'][index % 3];
    bot.level = 1 + Math.round(skill * 40);
    bot.spawnAt(this.arena.spawn(team, index), 0);
    this.bots.push(bot);
    return bot;
  }

  roster() {
    return [
      { id: 'you', name: this.playerName, team: 0, bot: false, level: this.playerLevel },
      ...this.bots.map((b) => ({
        id: b.id, name: b.name, team: b.team, bot: true, level: b.level,
        weapon: b.weaponId, camo: b.camoId, attachments: { optic: 'reddot', muzzle: 'comp', grip: 'vertical' },
      })),
    ];
  }

  /** Avance la simulation d'un pas. */
  tick(now, dt) {
    if (this.state !== 'live') return;
    this.timeLeft = Math.max(0, this.timeLeft - dt);

    // Synchronise la fiche du joueur avec le controleur.
    this.playerEntity.alive = this.player.alive;
    this.playerEntity.health = this.player.health;
    this.playerEntity.stance = this.player.height / 1.8;
    this.playerEntity.lastShotAt = this.player.weapon.lastShotAt;

    const world = {
      now, dt,
      combatants: this.combatants,
      physics: this.physics,
      onShoot: (shooter, dir) => this._resolveShot(shooter, dir, now),
    };

    for (const bot of this.bots) {
      if (!bot.alive && now >= bot.respawnAt) {
        bot.spawnAt(this._pickSpawn(bot.team), now);
        this._push({ t: 'spawn', id: bot.id });
      }
      bot.tick(world);
      // Regeneration passive, comme cote serveur.
      if (bot.alive && now - (bot.lastHurtAt ?? -99) > this.weaponsCfg.balance.regenDelay) {
        bot.health = Math.min(bot.maxHealth, bot.health + this.weaponsCfg.balance.regenRate * dt);
      }
    }

    const limit = this.modeCfg.scoreLimit;
    if (this.score[0] >= limit || this.score[1] >= limit || this.timeLeft <= 0) {
      this.state = 'over';
      const winner = this.score[0] === this.score[1] ? -1 : (this.score[0] > this.score[1] ? 0 : 1);
      this._push({ t: 'end', winner, score: this.score, summary: this.summary() });
    }
  }

  _pickSpawn(team) {
    const list = this.arena.data.spawns[String(team)] || [];
    let best = list[0], bestScore = -Infinity;
    for (const s of list) {
      let score = Math.random() * 3;
      for (const c of this.combatants) {
        if (!c.alive) continue;
        const d = Math.hypot(c.pos.x - s[0], c.pos.z - s[2]);
        score += c.team === team ? -Math.max(0, 14 - d) * 0.25 : Math.min(d, 40) * 0.55;
        if (c.team !== team && d < 12) score -= 45;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return new THREE.Vector3(best[0], 0, best[2]);
  }

  /** Tir du joueur local : meme resolution que pour les bots. */
  playerShoot(origin, dir, now) {
    this.playerEntity.lastShotAt = now;
    return this._resolveShot(this.playerEntity, dir, now, origin);
  }

  _resolveShot(shooter, dir, now, originOverride = null) {
    const stats = shooter === this.playerEntity ? this.player.weapon.cfg : shooter.stats;
    const origin = originOverride
      || (shooter.eye ? shooter.eye() : new THREE.Vector3(shooter.pos.x, shooter.pos.y + 1.62, shooter.pos.z));

    const wall = this.physics.raycast(origin, dir, 240);
    const limit = wall ? wall.dist : 240;

    let hit = null;
    for (const c of this.combatants) {
      if (c === shooter || c.team === shooter.team || !c.alive) continue;
      const res = rayPlayer(origin, dir, c.pos, c.stance ?? 1, limit);
      if (res && (!hit || res.dist < hit.dist)) hit = { ...res, victim: c };
    }

    const impact = origin.clone().addScaledVector(dir, hit ? hit.dist : limit);
    const result = {
      origin, dir, impact,
      normal: hit ? dir.clone().negate() : (wall ? wall.normal : new THREE.Vector3(0, 1, 0)),
      mat: hit ? 'flesh' : (wall ? wall.mat : 'air'),
      shooter, hit: null,
    };

    if (!hit) {
      this._push({ t: 'shot', id: shooter.id, o: origin, p: impact, hit: 0 });
      return result;
    }

    const dmg = damageAtRange(stats, hit.dist) * hit.mul;
    const victim = hit.victim;
    let res;
    if (victim === this.playerEntity) {
      this.player.takeDamage(dmg, now);
      this.playerEntity.health = this.player.health;
      res = { applied: dmg, killed: !this.player.alive };
      if (res.killed) this.playerEntity.deaths++;
    } else {
      res = victim.takeDamage(dmg, shooter, now);
      victim.lastHurtAt = now;
    }

    shooter.damage = (shooter.damage || 0) + res.applied;
    result.hit = { zone: hit.zone, amount: res.applied, killed: res.killed, victim };

    this._push({
      t: 'dmg', by: shooter.id, on: victim.id, zone: hit.zone,
      amount: res.applied, kill: res.killed ? 1 : 0,
      pos: impact.clone(),
    });

    if (res.killed) {
      shooter.kills = (shooter.kills || 0) + 1;
      this.score[shooter.team]++;
      if (victim.respawnAt !== undefined) {
        victim.respawnAt = now + this.weaponsCfg.balance.respawnDelay;
      }
      this._push({
        t: 'kill', by: shooter.id, on: victim.id,
        headshot: hit.zone === 'head' ? 1 : 0, score: [...this.score],
        respawnIn: this.weaponsCfg.balance.respawnDelay,
      });
    }
    return result;
  }

  /** Explosion de grenade (resolue localement). */
  explode(center, byId, now) {
    const g = this.weaponsCfg.grenades;
    const shooter = this.combatants.find((c) => c.id === byId) || this.playerEntity;
    this._push({ t: 'blast', at: center.clone() });
    const chest = new THREE.Vector3();
    for (const c of this.combatants) {
      if (!c.alive) continue;
      chest.set(c.pos.x, c.pos.y + 1.1 * (c.stance ?? 1), c.pos.z);
      const dist = chest.distanceTo(center);
      if (dist > g.radius) continue;
      if (!this.physics.lineOfSight(center, chest)) continue;
      if (c.team === shooter.team && c !== shooter) continue;        // pas de tir ami
      const dmg = g.damage * Math.max(0, 1 - (dist / g.radius) ** 1.45);
      let res;
      if (c === this.playerEntity) {
        this.player.takeDamage(dmg, now);
        this.playerEntity.health = this.player.health;
        res = { applied: dmg, killed: !this.player.alive };
        if (res.killed) this.playerEntity.deaths++;
      } else {
        res = c.takeDamage(dmg, shooter, now);
        c.lastHurtAt = now;
      }
      this._push({ t: 'dmg', by: byId, on: c.id, zone: 'blast', amount: res.applied,
                   kill: res.killed ? 1 : 0, pos: chest.clone() });
      if (res.killed) {
        if (c !== shooter) { shooter.kills = (shooter.kills || 0) + 1; this.score[shooter.team]++; }
        if (c.respawnAt !== undefined) c.respawnAt = now + this.weaponsCfg.balance.respawnDelay;
        this._push({ t: 'kill', by: byId, on: c.id, headshot: 0, score: [...this.score],
                     respawnIn: this.weaponsCfg.balance.respawnDelay });
      }
    }
  }

  respawnPlayer(now) {
    const spawn = this._pickSpawn(0);
    this.player.respawn(spawn);
    this.playerEntity.alive = true;
    this.playerEntity.health = this.player.health;
    return spawn;
  }

  summary() {
    return [this.playerEntity, ...this.bots].map((c) => ({
      id: c.id, name: c.name, team: c.team, bot: !!c.isBot,
      kills: c.kills || 0, deaths: c.deaths || 0,
      damage: Math.round(c.damage || 0), xp: 0,
    })).sort((a, b) => b.kills - a.kills);
  }

  scoreboard(youId = 'you') {
    return [this.playerEntity, ...this.bots].map((c) => ({
      name: c.name, team: c.team, bot: !!c.isBot,
      kills: c.kills || 0, deaths: c.deaths || 0, damage: c.damage || 0,
      you: c.id === youId,
    }));
  }

  _push(e) { this._emit('event', e); }

  interpolated() {
    const out = new Map();
    for (const b of this.bots) {
      out.set(b.id, {
        id: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z,
        yaw: b.yaw, pitch: b.pitch, stance: b.stance,
        health: b.health, alive: b.alive,
        sprinting: b.sprinting, ads: b.ads, sliding: false,
        grounded: true, reloading: b.reloading,
        kills: b.kills, deaths: b.deaths, ammo: b.ammo,
        vx: b.vel.x, vz: b.vel.z,
      });
    }
    return out;
  }
}

/* ----------------------------------------------------------- utilitaires */

/** Equivalent JS de Config::resolveWeapon (PHP) : memes chiffres des deux cotes. */
export function resolveWeapon(cfg, weaponId, attachments = {}) {
  const w = cfg.weapons[weaponId] || cfg.weapons.mk18;
  const s = {
    id: weaponId, name: w.name, shape: w.shape,
    damage: w.damage, rpm: w.rpm, magazine: w.magazine, reserve: w.reserve,
    reloadTime: w.reloadTime, reloadEmptyTime: w.reloadEmptyTime,
    adsTime: w.adsTime, spreadHip: w.spreadHip, spreadAds: w.spreadAds,
    spreadMoveMul: w.spreadMoveMul,
    recoilVert: w.recoil.vert, recoilHoriz: w.recoil.horiz,
    recovery: w.recoil.recovery, kick: w.recoil.kick, pattern: w.recoil.pattern,
    rangeFull: w.rangeFull, rangeFalloff: w.rangeFalloff, falloffMin: w.falloffMin,
    mobility: w.mobility, bulletsPerShot: w.bulletsPerShot, auto: w.auto,
    zoom: 1.12, silent: false, visibleLaser: false,
  };
  const map = {
    adsTime: 'adsTime', spreadAds: 'spreadAds', spreadHip: 'spreadHip',
    spreadMoveMul: 'spreadMoveMul', recoilVert: 'recoilVert', recoilHoriz: 'recoilHoriz',
    rangeFull: 'rangeFull', rangeFalloff: 'rangeFalloff', mobility: 'mobility',
    magazine: 'magazine', reloadTime: 'reloadTime',
  };
  const baseReload = w.reloadTime;
  for (const slot of cfg.slots) {
    const chosen = attachments[slot];
    if (!chosen) continue;
    for (const att of cfg.attachments[slot] || []) {
      if (att.id !== chosen) continue;
      for (const [key, delta] of Object.entries(att.mods)) {
        if (map[key]) s[map[key]] += delta;
        else if (key === 'zoom') s.zoom = delta;
        else if (key === 'silent') s.silent = true;
        else if (key === 'visibleLaser') s.visibleLaser = true;
      }
    }
  }
  s.adsTime = Math.max(0.1, s.adsTime);
  s.spreadAds = Math.max(0.04, s.spreadAds);
  s.spreadHip = Math.max(0.5, s.spreadHip);
  s.recoilVert = Math.max(0.12, s.recoilVert);
  s.recoilHoriz = Math.max(0.05, s.recoilHoriz);
  s.reloadTime = Math.max(0.9, s.reloadTime);
  s.reloadEmptyTime = Math.max(1.1, s.reloadEmptyTime + (s.reloadTime - baseReload));
  s.mobility = Math.max(0.75, Math.min(1.25, s.mobility));
  s.magazine = Math.max(5, Math.round(s.magazine));
  s.rangeFull = Math.max(8, s.rangeFull);
  s.rangeFalloff = Math.max(s.rangeFull + 6, s.rangeFalloff);
  s.fireInterval = 60 / Math.max(60, s.rpm);
  return s;
}

export function damageAtRange(stats, dist) {
  if (dist <= stats.rangeFull) return stats.damage;
  if (dist >= stats.rangeFalloff) return stats.damage * stats.falloffMin;
  const t = (dist - stats.rangeFull) / Math.max(1e-3, stats.rangeFalloff - stats.rangeFull);
  return stats.damage * (1 - t * (1 - stats.falloffMin));
}

function jitterDir(dir, spreadRad, yaw) {
  if (spreadRad <= 0) return dir.clone();
  const out = dir.clone();
  const right = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const ang = Math.random() * Math.PI * 2;
  const mag = Math.sqrt(Math.random()) * spreadRad;
  return out.addScaledVector(right, Math.cos(ang) * mag)
            .addScaledVector(up, Math.sin(ang) * mag)
            .normalize();
}

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
