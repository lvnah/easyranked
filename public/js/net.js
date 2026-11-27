/**
 * EasyRanked :: client reseau.
 *
 * - envoi d'inputs a la cadence du serveur (30-60 Hz) ;
 * - reception de snapshots et interpolation des autres joueurs avec un retard
 *   fixe (~2 ticks) : les mouvements distants restent fluides meme avec de la
 *   gigue, au prix d'un leger decalage que le serveur compense au tir ;
 * - le serveur reste l'autorite : vie, munitions et score viennent de lui,
 *   le client ne fait que predire son propre deplacement.
 */

export class NetClient {
  constructor() {
    this.ws = null;
    this.you = null;
    this.room = null;
    this.mode = '2v2';
    this.team = 0;
    this.tickRate = 40;
    this.connected = false;
    this.ping = 0;
    this.seq = 0;
    this.state = 'offline';
    this.scoreLimit = 0;

    /** @type {Map<string, object>} fiches des joueurs (nom, equipe, arme...) */
    this.roster = new Map();
    /** @type {Array<{t:number, players:Map}>} tampon d'interpolation */
    this.buffer = [];
    this.bufferDelay = 0.1;
    this.serverTimeOffset = 0;

    this.handlers = {};
    this._lastInputAt = 0;
  }

  on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
  _emit(event, payload) { for (const fn of this.handlers[event] || []) fn(payload); }

  /** @param {string} url  ws://host:port */
  connect(url, hello) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        reject(new Error('URL WebSocket invalide : ' + e.message));
        return;
      }
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; this.ws?.close(); reject(new Error('Delai de connexion depasse.')); }
      }, 8000);

      this.ws.onopen = () => {
        this.connected = true;
        this.send({ t: 'hello', ...hello });
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this._handle(msg);
        if (msg.t === 'welcome' && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve(msg);
        }
        if (msg.t === 'error' && msg.fatal && !settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(msg.msg));
        }
      };
      this.ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Connexion au serveur impossible. Lance : php server/server.php'));
        }
      };
      this.ws.onclose = () => {
        this.connected = false;
        this.state = 'offline';
        this._emit('close', null);
      };
    });
  }

  disconnect() {
    if (this.ws && this.connected) {
      try { this.send({ t: 'leave' }); } catch { /* socket deja ferme */ }
      this.ws.close();
    }
    this.ws = null;
    this.connected = false;
    this.roster.clear();
    this.buffer.length = 0;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /* ------------------------------------------------------- reception */

  _handle(msg) {
    switch (msg.t) {
      case 'hello':
        this.tickRate = msg.tickRate || 40;
        this.balance = msg.balance;
        break;

      case 'welcome':
        this.you = msg.you;
        this.room = msg.room;
        this.mode = msg.mode;
        this.team = msg.team;
        this.tickRate = msg.tickRate || this.tickRate;
        this.state = msg.state;
        this.scoreLimit = msg.scoreLimit;
        this.bufferDelay = Math.max(0.06, 2.2 / this.tickRate);
        this.roster.clear();
        for (const p of msg.roster || []) this.roster.set(p.id, p);
        this._emit('welcome', msg);
        break;

      case 'snap':
        this._onSnapshot(msg);
        break;

      case 'ping':
        this.send({ t: 'pong', id: msg.id });
        break;

      case 'left':
      case 'closed':
        this.roster.clear();
        this.buffer.length = 0;
        this._emit(msg.t, msg);
        break;

      case 'error':
        this._emit('error', msg);
        break;
    }
  }

  _onSnapshot(msg) {
    const now = performance.now() / 1000;
    // Horloge serveur estimee : utile pour dater les tirs cote serveur.
    this.serverTimeOffset = msg.now - now;
    this.state = msg.state;

    const players = new Map();
    for (const p of msg.p) {
      players.set(p[0], {
        id: p[0],
        x: p[1], y: p[2], z: p[3],
        yaw: p[4], pitch: p[5],
        stance: p[6],
        health: p[7], shield: p[8],
        alive: p[9] === 1,
        sprinting: !!(p[10] & 1), ads: !!(p[10] & 2), sliding: !!(p[10] & 4),
        grounded: !!(p[10] & 8), reloading: !!(p[10] & 16),
        kills: p[11], deaths: p[12], ammo: p[13], ackSeq: p[14],
      });
    }
    this.buffer.push({ t: now, players });
    // On ne garde qu'une seconde d'historique.
    while (this.buffer.length > 2 && now - this.buffer[0].t > 1.0) this.buffer.shift();

    this.score = msg.score;
    this.timeLeft = msg.left;

    for (const e of msg.e || []) {
      if (e.t === 'join') this.roster.set(e.player.id, e.player);
      if (e.t === 'leave') this.roster.delete(e.id);
      this._emit('event', e);
    }
    this._emit('snapshot', msg);
  }

  /**
   * Etat interpole des joueurs distants a l'instant courant.
   * @returns {Map<string, object>}
   */
  interpolated() {
    const now = performance.now() / 1000 - this.bufferDelay;
    const buf = this.buffer;
    if (buf.length === 0) return new Map();
    if (buf.length === 1 || now <= buf[0].t) return buf[0].players;

    for (let i = buf.length - 1; i > 0; i--) {
      const a = buf[i - 1];
      const b = buf[i];
      if (now >= a.t && now <= b.t) {
        const k = (now - a.t) / Math.max(1e-6, b.t - a.t);
        const out = new Map();
        for (const [id, pb] of b.players) {
          const pa = a.players.get(id);
          if (!pa) { out.set(id, pb); continue; }
          out.set(id, {
            ...pb,
            x: pa.x + (pb.x - pa.x) * k,
            y: pa.y + (pb.y - pa.y) * k,
            z: pa.z + (pb.z - pa.z) * k,
            yaw: pa.yaw + wrapAngle(pb.yaw - pa.yaw) * k,
            pitch: pa.pitch + (pb.pitch - pa.pitch) * k,
            stance: pa.stance + (pb.stance - pa.stance) * k,
            // Vitesse estimee : sert a animer la marche des avatars distants.
            vx: (pb.x - pa.x) / Math.max(1e-6, b.t - a.t),
            vz: (pb.z - pa.z) / Math.max(1e-6, b.t - a.t),
          });
        }
        return out;
      }
    }
    // Extrapolation courte si le dernier snapshot est en retard.
    return buf[buf.length - 1].players;
  }

  /* ---------------------------------------------------------- emission */

  /** Envoie l'input si l'intervalle de tick est ecoule. */
  sendInput(player, now) {
    if (!this.connected) return;
    const interval = 1 / this.tickRate;
    if (now - this._lastInputAt < interval) return;
    this._lastInputAt = now;
    this.send(player.snapshotInput(++this.seq));
  }

  sendShot(origin, dir) {
    this.send({
      t: 'shoot',
      o: [r2(origin.x), r2(origin.y), r2(origin.z)],
      d: [r3(dir.x), r3(dir.y), r3(dir.z)],
      lat: Math.round(this.ping),
    });
  }

  sendReload() { this.send({ t: 'reload' }); }
  sendGrenade(dir) { this.send({ t: 'nade', d: [r3(dir.x), r3(dir.y), r3(dir.z)] }); }
  sendChat(msg) { this.send({ t: 'chat', msg }); }

  playerInfo(id) { return this.roster.get(id) || null; }
  nameOf(id) { return this.roster.get(id)?.name || 'Inconnu'; }
  teamOf(id) { return this.roster.get(id)?.team ?? 0; }
}

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Mesure du ping : moyenne glissante des aller-retours. */
export class PingMeter {
  constructor() { this.samples = []; }
  push(ms) {
    this.samples.push(ms);
    if (this.samples.length > 12) this.samples.shift();
  }
  get value() {
    if (!this.samples.length) return 0;
    return Math.round(this.samples.reduce((a, b) => a + b, 0) / this.samples.length);
  }
}
