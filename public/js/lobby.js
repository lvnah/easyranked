/**
 * EasyRanked :: lobby, progression et atelier d'armurerie (Gunsmith).
 *
 * - connexion / inscription via l'API REST ;
 * - choix du mode (1v1 a 4v4), multijoueur ou entrainement contre des bots ;
 * - Gunsmith debloque au niveau 5 : l'arme est inspectee en 3D temps reel et
 *   chaque accessoire modifie concretement les statistiques affichees.
 */
import * as THREE from 'three';
import { buildDetailedWeapon } from './visuals.js';
import { material, skyTexture } from './textures.js';
import { resolveWeapon } from './bots.js';

const API = './api';

/* ----------------------------------------------------------------- API */

export const Api = {
  token: localStorage.getItem('er_token') || '',

  async call(path, { method = 'GET', body = null } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const res = await fetch(`${API}/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  },

  setToken(t) {
    this.token = t || '';
    if (t) localStorage.setItem('er_token', t);
    else localStorage.removeItem('er_token');
  },

  register: (username, password) => Api.call('register', { method: 'POST', body: { username, password } }),
  login: (username, password) => Api.call('login', { method: 'POST', body: { username, password } }),
  me: () => Api.call('me'),
  saveLoadout: (payload) => Api.call('loadout', { method: 'POST', body: payload }),
  leaderboard: () => Api.call('leaderboard'),
};

/* ------------------------------------------------- inspecteur 3D d'arme */

/** Petit rendu isole : fait tourner l'arme dans le panneau Gunsmith. */
class WeaponViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.environment = skyTexture(256);
    this.scene.environmentIntensity = 0.7;

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 20);
    this.camera.position.set(0.0, 0.1, 1.55);

    const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
    key.position.set(-1.4, 1.6, 1.8);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb6e8, 1.6);
    rim.position.set(1.8, 0.6, -1.4);
    this.scene.add(rim);
    this.scene.add(new THREE.HemisphereLight(0xcfe0f0, 0x303438, 1.0));

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.autoRotate = true;
    this.angle = -0.6;
    this.tilt = 0.12;
    this.dragging = false;
    this._bindDrag();
    this._running = true;
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _bindDrag() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.autoRotate = false;
      c.setPointerCapture(e.pointerId);
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.angle += (e.clientX - this._lastX) * 0.01;
      this.tilt = THREE.MathUtils.clamp(this.tilt + (e.clientY - this._lastY) * 0.006, -0.7, 0.7);
      this._lastX = e.clientX;
      this._lastY = e.clientY;
    });
    const stop = () => { this.dragging = false; };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
    c.addEventListener('pointerleave', stop);
    c.addEventListener('dblclick', () => { this.autoRotate = true; });
  }

  setWeapon(shape, camo, attachments) {
    this.pivot.clear();
    const w = buildDetailedWeapon({ shape, camo, attachments });
    // Recentrage sur la boite englobante, pour que toutes les armes
    // (du PM a la lunette 3.4x) soient cadrees de la meme facon.
    const bb = new THREE.Box3().setFromObject(w);
    const center = bb.getCenter(new THREE.Vector3());
    this.span = bb.getSize(new THREE.Vector3());
    w.position.sub(center);
    this.pivot.add(w);
    this.model = w;
    this._frame();
  }

  /** Distance de camera deduite du champ de vision : l'arme remplit le cadre. */
  _frame() {
    if (!this.span) return;
    const aspect = this.camera.aspect || 1.8;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    // L'arme tourne : on prend sa plus grande dimension horizontale projetee.
    const width = Math.hypot(this.span.x, this.span.z);
    const height = this.span.y;
    const distH = (width / 2) / (Math.tan(halfFov) * aspect);
    const distV = (height / 2) / Math.tan(halfFov);
    const dist = Math.max(distH, distV) / 0.82 + 0.1;
    this.camera.position.set(0, 0.02, dist);
    this.camera.lookAt(0, 0, 0);
  }

  resize() {
    const w = this.canvas.clientWidth || 480;
    const h = this.canvas.clientHeight || 260;
    if (this._w === w && this._h === h) return;
    this._w = w; this._h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this._frame();
  }

  _loop() {
    if (!this._running) return;
    requestAnimationFrame(this._loop);
    if (!this.canvas.isConnected || this.canvas.offsetParent === null) return;
    this.resize();
    if (this.autoRotate) this.angle += 0.006;
    this.pivot.rotation.y = this.angle;
    this.pivot.rotation.x = this.tilt;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this._running = false;
    this.renderer.dispose();
  }
}

/* ---------------------------------------------------------------- lobby */

export class Lobby {
  /**
   * @param {HTMLElement} root
   * @param {object} cfg  shared/weapons.json
   */
  constructor(root, cfg) {
    this.root = root;
    this.cfg = cfg;
    this.user = null;
    this.activeSlot = 0;
    this.draft = null;
    this.viewer = null;
    this.onPlay = null;        // ({ mode, bots, skill, loadout, slot }) => void
    this._build();
  }

  /* ------------------------------------------------------------ markup */

  _build() {
    this.root.innerHTML = `
      <div class="lobby" id="lobby">
        <header class="lb-top">
          <div class="lb-brand"><b>EASY</b><span>RANKED</span><i>FOUNDRY</i></div>
          <div class="lb-user" id="lbUser"></div>
        </header>

        <div class="lb-body">
          <!-- ------------------------------------------------ connexion -->
          <section class="lb-panel lb-auth" id="lbAuth">
            <h2>Connexion</h2>
            <p class="lb-sub">Un compte conserve ta progression (niveaux 1 a 100), tes classes et tes statistiques.</p>
            <label>Pseudo <input id="lbUsername" type="text" autocomplete="username" maxlength="18" placeholder="Operateur"></label>
            <label>Mot de passe <input id="lbPassword" type="password" autocomplete="current-password" placeholder="6 caracteres minimum"></label>
            <div class="lb-row">
              <button class="btn btn-primary" id="lbLogin">Se connecter</button>
              <button class="btn" id="lbRegister">Creer un compte</button>
            </div>
            <button class="btn btn-ghost" id="lbGuest">Jouer en invite (sans progression)</button>
            <div class="lb-error" id="lbError"></div>
          </section>

          <!-- --------------------------------------------------- partie -->
          <section class="lb-panel lb-play" id="lbPlay" hidden>
            <h2>Deploiement</h2>
            <div class="mode-grid" id="lbModes"></div>
            <div class="lb-row lb-opts">
              <label class="switch"><input type="checkbox" id="lbBots" checked><span>Completer avec des bots</span></label>
              <label class="slider">Difficulte des bots
                <input type="range" id="lbSkill" min="10" max="100" value="60" step="5">
                <b id="lbSkillLabel">Regulier</b>
              </label>
            </div>
            <div class="lb-row">
              <label class="switch"><input type="checkbox" id="lbOnline"><span>Multijoueur temps reel (serveur PHP)</span></label>
              <input type="text" id="lbServer" class="lb-server" placeholder="ws://localhost:8081" value="">
            </div>
            <button class="btn btn-play" id="lbStart">LANCER LA PARTIE</button>
            <div class="lb-hint" id="lbPlayHint"></div>
          </section>

          <!-- ------------------------------------------------- gunsmith -->
          <section class="lb-panel lb-gunsmith" id="lbGunsmith" hidden>
            <div class="gs-head">
              <h2>Armurerie</h2>
              <div class="gs-slots" id="lbSlots"></div>
            </div>
            <div class="gs-locked" id="lbGsLocked" hidden>
              <b>Verrouille</b>
              <p>La creation de classe se debloque au <strong>niveau 5</strong>.
                 Tu peux deja choisir ton arme parmi celles debloquees.</p>
            </div>
            <div class="gs-main">
              <div class="gs-view">
                <canvas id="lbWeaponCanvas"></canvas>
                <div class="gs-viewhint">Glisser pour faire pivoter &middot; double-clic : rotation auto</div>
                <input class="gs-name" id="lbLoadoutName" maxlength="18" placeholder="Nom de la classe">
              </div>
              <div class="gs-cols">
                <div class="gs-col">
                  <h3>Arme</h3>
                  <div class="gs-list" id="lbWeapons"></div>
                  <h3>Camouflage</h3>
                  <div class="gs-camos" id="lbCamos"></div>
                </div>
                <div class="gs-col">
                  <h3>Accessoires</h3>
                  <div class="gs-attachments" id="lbAttachments"></div>
                </div>
                <div class="gs-col">
                  <h3>Statistiques</h3>
                  <div class="gs-stats" id="lbStats"></div>
                  <button class="btn btn-primary" id="lbSave">Enregistrer la classe</button>
                  <div class="lb-hint" id="lbSaveHint"></div>
                </div>
              </div>
            </div>
          </section>

          <!-- ---------------------------------------------- progression -->
          <aside class="lb-panel lb-side" id="lbSide" hidden>
            <h2>Progression</h2>
            <div class="xp-block">
              <div class="xp-level"><span id="lbLevel">1</span><i>NIVEAU</i></div>
              <div class="xp-bar"><div class="xp-fill" id="lbXpFill"></div></div>
              <div class="xp-text" id="lbXpText">0 / 0 XP</div>
            </div>
            <div class="stat-grid" id="lbStatGrid"></div>
            <h2>Classement</h2>
            <div class="lb-board" id="lbBoard"></div>
          </aside>
        </div>
      </div>`;

    const q = (s) => this.root.querySelector(s);
    this.el = {
      lobby: q('#lobby'), auth: q('#lbAuth'), play: q('#lbPlay'),
      gunsmith: q('#lbGunsmith'), side: q('#lbSide'),
      username: q('#lbUsername'), password: q('#lbPassword'), error: q('#lbError'),
      login: q('#lbLogin'), register: q('#lbRegister'), guest: q('#lbGuest'),
      user: q('#lbUser'), modes: q('#lbModes'), bots: q('#lbBots'),
      skill: q('#lbSkill'), skillLabel: q('#lbSkillLabel'),
      online: q('#lbOnline'), server: q('#lbServer'),
      start: q('#lbStart'), playHint: q('#lbPlayHint'),
      slots: q('#lbSlots'), gsLocked: q('#lbGsLocked'),
      weaponCanvas: q('#lbWeaponCanvas'), loadoutName: q('#lbLoadoutName'),
      weapons: q('#lbWeapons'), camos: q('#lbCamos'), attachments: q('#lbAttachments'),
      stats: q('#lbStats'), save: q('#lbSave'), saveHint: q('#lbSaveHint'),
      level: q('#lbLevel'), xpFill: q('#lbXpFill'), xpText: q('#lbXpText'),
      statGrid: q('#lbStatGrid'), board: q('#lbBoard'),
    };

    this.mode = '2v2';
    this._renderModes();
    this._bind();
    // Adresse du serveur : meme hote que la page, port WebSocket par defaut.
    this.el.server.value = `ws://${location.hostname || 'localhost'}:8081`;
  }

  _bind() {
    this.el.login.onclick = () => this._auth('login');
    this.el.register.onclick = () => this._auth('register');
    this.el.guest.onclick = () => this._guest();
    this.el.password.onkeydown = (e) => { if (e.key === 'Enter') this._auth('login'); };

    this.el.skill.oninput = () => {
      const v = +this.el.skill.value;
      this.el.skillLabel.textContent =
        v < 30 ? 'Recrue' : v < 50 ? 'Entraine' : v < 72 ? 'Regulier' : v < 90 ? 'Veteran' : 'Elite';
    };
    this.el.online.onchange = () => {
      this.el.server.disabled = !this.el.online.checked;
      this.el.playHint.textContent = this.el.online.checked
        ? 'Le serveur WebSocket doit tourner : php server/server.php'
        : '';
    };
    this.el.server.disabled = true;
    this.el.start.onclick = () => this._start();
    this.el.save.onclick = () => this._saveLoadout();
    this.el.loadoutName.oninput = () => { if (this.draft) this.draft.name = this.el.loadoutName.value; };
  }

  _renderModes() {
    const labels = {
      '1v1': ['1v1', 'Duel', 'Face a face technique'],
      '2v2': ['2v2', 'Duo', 'Le format le plus joue'],
      '3v3': ['3v3', 'Escouade', 'Jeu de zone'],
      '4v4': ['4v4', 'Section', 'Combats continus'],
    };
    this.el.modes.innerHTML = Object.entries(labels).map(([id, [t, n, d]]) => `
      <button class="mode-card" data-mode="${id}" data-on="${id === this.mode ? '1' : '0'}">
        <b>${t}</b><span>${n}</span><i>${d}</i>
        <em>${this.cfg.modes[id].scoreLimit} elim.</em>
      </button>`).join('');
    for (const btn of this.el.modes.querySelectorAll('.mode-card')) {
      btn.onclick = () => {
        this.mode = btn.dataset.mode;
        for (const b of this.el.modes.querySelectorAll('.mode-card')) {
          b.dataset.on = b.dataset.mode === this.mode ? '1' : '0';
        }
      };
    }
  }

  /* ---------------------------------------------------------- connexion */

  async _auth(kind) {
    const u = this.el.username.value.trim();
    const p = this.el.password.value;
    this.el.error.textContent = '';
    if (!u || !p) { this.el.error.textContent = 'Renseigne un pseudo et un mot de passe.'; return; }
    this._busy(true);
    try {
      const res = kind === 'login' ? await Api.login(u, p) : await Api.register(u, p);
      Api.setToken(res.token);
      this.setUser(res.user);
    } catch (e) {
      this.el.error.textContent = e.message;
    } finally {
      this._busy(false);
    }
  }

  _guest() {
    Api.setToken('');
    this.setUser({
      id: 0, username: 'Invite', level: 1, xp: 0, xpNext: 900, gunsmith: false, guest: true,
      stats: { kills: 0, deaths: 0, headshots: 0, damage: 0, matches: 0, wins: 0, streak: 0, time: 0 },
      loadouts: [{ slot: 0, name: 'Standard', weapon: 'mk18', camo: 'default', attachments: {} }],
    });
  }

  _busy(on) {
    for (const b of [this.el.login, this.el.register, this.el.guest]) b.disabled = on;
  }

  /** Tente une reconnexion automatique avec le jeton stocke. */
  async tryRestore() {
    if (!Api.token) return false;
    try {
      const res = await Api.me();
      this.setUser(res.user);
      return true;
    } catch {
      Api.setToken('');
      return false;
    }
  }

  setUser(user) {
    this.user = user;
    this.el.auth.hidden = true;
    this.el.play.hidden = false;
    this.el.gunsmith.hidden = false;
    this.el.side.hidden = false;

    this.el.user.innerHTML = `
      <span class="lb-username">${escapeHtml(user.username)}</span>
      <span class="lb-userlvl">NIV ${user.level}</span>
      ${user.guest ? '' : '<button class="btn btn-ghost btn-small" id="lbLogout">Deconnexion</button>'}`;
    const logout = this.root.querySelector('#lbLogout');
    if (logout) {
      logout.onclick = async () => {
        try { await Api.call('logout', { method: 'POST' }); } catch { /* jeton deja invalide */ }
        Api.setToken('');
        location.reload();
      };
    }

    this.activeSlot = 0;
    this._renderProgress();
    this._renderSlots();
    this._loadDraft(0);
    if (!user.guest) this._loadBoard();
  }

  _renderProgress() {
    const u = this.user;
    this.el.level.textContent = u.level;
    const pct = u.xpNext > 0 ? Math.min(100, (u.xp / u.xpNext) * 100) : 100;
    this.el.xpFill.style.width = pct + '%';
    this.el.xpText.textContent = u.xpNext > 0
      ? `${u.xp} / ${u.xpNext} XP`
      : 'Niveau maximum atteint';

    const s = u.stats || {};
    const kd = s.deaths > 0 ? (s.kills / s.deaths).toFixed(2) : String(s.kills || 0);
    const acc = s.kills > 0 ? Math.round((s.headshots / s.kills) * 100) : 0;
    const rows = [
      ['Eliminations', s.kills || 0], ['Morts', s.deaths || 0], ['Ratio E/M', kd],
      ['Tirs a la tete', `${acc}%`], ['Degats', Math.round(s.damage || 0)],
      ['Parties', s.matches || 0], ['Victoires', s.wins || 0],
      ['Meilleure serie', s.streak || 0],
    ];
    this.el.statGrid.innerHTML = rows.map(([k, v]) =>
      `<div class="stat"><i>${k}</i><b>${v}</b></div>`).join('');
  }

  async _loadBoard() {
    try {
      const { leaderboard } = await Api.leaderboard();
      this.el.board.innerHTML = leaderboard.length
        ? leaderboard.map((r, i) => `
            <div class="board-row" data-you="${r.username === this.user.username ? '1' : '0'}">
              <span class="br-rank">${i + 1}</span>
              <span class="br-name">${escapeHtml(r.username)}</span>
              <span class="br-lvl">${r.level}</span>
              <span class="br-kd">${r.kd}</span>
            </div>`).join('')
        : '<div class="lb-hint">Aucune partie enregistree.</div>';
    } catch {
      this.el.board.innerHTML = '<div class="lb-hint">Classement indisponible.</div>';
    }
  }

  /* ---------------------------------------------------------- gunsmith */

  _renderSlots() {
    const loadouts = this.user.loadouts || [];
    this.el.slots.innerHTML = loadouts.map((l) => `
      <button class="gs-slot" data-slot="${l.slot}" data-on="${l.slot === this.activeSlot ? '1' : '0'}">
        <b>${l.slot + 1}</b><span>${escapeHtml(l.name)}</span>
      </button>`).join('');
    for (const b of this.el.slots.querySelectorAll('.gs-slot')) {
      b.onclick = () => {
        this.activeSlot = +b.dataset.slot;
        for (const o of this.el.slots.querySelectorAll('.gs-slot')) {
          o.dataset.on = +o.dataset.slot === this.activeSlot ? '1' : '0';
        }
        this._loadDraft(this.activeSlot);
      };
    }
  }

  _loadDraft(slot) {
    const src = (this.user.loadouts || []).find((l) => l.slot === slot)
      || { slot, name: 'Classe', weapon: 'mk18', camo: 'default', attachments: {} };
    // Les accessoires arrivent parfois en tableau vide depuis PHP : on normalise.
    const att = Array.isArray(src.attachments) ? {} : { ...(src.attachments || {}) };
    this.draft = { slot, name: src.name, weapon: src.weapon, camo: src.camo, attachments: att };
    this.el.loadoutName.value = src.name;

    const locked = !this.user.gunsmith;
    this.el.gsLocked.hidden = !locked;
    this.el.attachments.dataset.locked = locked ? '1' : '0';
    this.el.loadoutName.disabled = locked;
    this.el.save.disabled = !!this.user.guest;
    this.el.saveHint.textContent = this.user.guest
      ? 'Cree un compte pour enregistrer tes classes.' : '';

    if (!this.viewer) this.viewer = new WeaponViewer(this.el.weaponCanvas);
    this._renderGunsmith();
  }

  _renderGunsmith() {
    const d = this.draft;
    const level = this.user.level;
    const unlocked = (min) => level >= min;

    // --- armes
    this.el.weapons.innerHTML = Object.entries(this.cfg.weapons).map(([id, w]) => `
      <button class="gs-item" data-weapon="${id}" data-on="${id === d.weapon ? '1' : '0'}"
              data-locked="${unlocked(w.minLevel) ? '0' : '1'}" ${unlocked(w.minLevel) ? '' : 'disabled'}>
        <b>${w.name}</b><span>${w.class}</span>
        ${unlocked(w.minLevel) ? '' : `<em>NIV ${w.minLevel}</em>`}
      </button>`).join('');
    for (const b of this.el.weapons.querySelectorAll('[data-weapon]')) {
      b.onclick = () => {
        d.weapon = b.dataset.weapon;
        // Les accessoires restent valides : ils sont generiques a toutes les armes.
        this._renderGunsmith();
      };
    }

    // --- camouflages
    this.el.camos.innerHTML = this.cfg.camos.map((c) => `
      <button class="gs-camo" data-camo="${c.id}" data-on="${c.id === d.camo ? '1' : '0'}"
              data-locked="${unlocked(c.minLevel) ? '0' : '1'}" ${unlocked(c.minLevel) ? '' : 'disabled'}
              style="--camo-base:${c.base};--camo-accent:${c.accent}" title="${c.name}${unlocked(c.minLevel) ? '' : ` (niveau ${c.minLevel})`}">
        <i></i><span>${c.name}</span>
      </button>`).join('');
    for (const b of this.el.camos.querySelectorAll('[data-camo]')) {
      b.onclick = () => { d.camo = b.dataset.camo; this._renderGunsmith(); };
    }

    // --- accessoires (5 slots + chargeur + poignee)
    const slotLabels = {
      optic: 'Optique', barrel: 'Canon', muzzle: 'Bouche', stock: 'Crosse',
      laser: 'Laser', grip: 'Poignee', mag: 'Chargeur',
    };
    this.el.attachments.innerHTML = this.cfg.slots.map((slot) => {
      const list = this.cfg.attachments[slot] || [];
      const cur = d.attachments[slot] || '';
      return `
        <div class="gs-slotgroup">
          <h4>${slotLabels[slot] || slot}</h4>
          <div class="gs-opts">
            <button class="gs-opt" data-slot="${slot}" data-id="" data-on="${cur === '' ? '1' : '0'}">Aucun</button>
            ${list.map((a) => `
              <button class="gs-opt" data-slot="${slot}" data-id="${a.id}"
                      data-on="${cur === a.id ? '1' : '0'}"
                      data-locked="${unlocked(a.minLevel) ? '0' : '1'}"
                      ${unlocked(a.minLevel) && this.user.gunsmith ? '' : 'disabled'}
                      title="${describeMods(a.mods)}">
                ${a.name}${unlocked(a.minLevel) ? '' : ` <em>NIV ${a.minLevel}</em>`}
              </button>`).join('')}
          </div>
        </div>`;
    }).join('');
    for (const b of this.el.attachments.querySelectorAll('.gs-opt')) {
      b.onclick = () => {
        const slot = b.dataset.slot;
        if (b.dataset.id) d.attachments[slot] = b.dataset.id;
        else delete d.attachments[slot];
        this._renderGunsmith();
      };
    }

    // --- statistiques resultantes (memes formules que le serveur)
    const base = resolveWeapon(this.cfg, d.weapon, {});
    const now = resolveWeapon(this.cfg, d.weapon, this.user.gunsmith ? d.attachments : {});
    const bal = this.cfg.balance;
    // Reserve effective : points de vie + bouclier (le bouclier absorbe avant).
    const pool = bal.maxHealth + bal.shieldMax;
    const shots = Math.ceil(pool / now.damage);
    const metrics = [
      ['Degats', now.damage, base.damage, 60, false],
      ['Cadence', now.rpm, base.rpm, 1000, false],
      ['Portee utile', now.rangeFull, base.rangeFull, 90, false],
      ['Recul vertical', now.recoilVert, base.recoilVert, 1.6, true],
      ['Recul lateral', now.recoilHoriz, base.recoilHoriz, 0.6, true],
      ['Vitesse de visee', now.adsTime, base.adsTime, 0.5, true],
      ['Dispersion (hanche)', now.spreadHip, base.spreadHip, 5, true],
      ['Dispersion (visee)', now.spreadAds, base.spreadAds, 0.6, true],
      ['Mobilite', now.mobility, base.mobility, 1.3, false],
      ['Chargeur', now.magazine, base.magazine, 50, false],
      ['Rechargement', now.reloadTime, base.reloadTime, 3.5, true],
    ];
    this.el.stats.innerHTML = metrics.map(([label, v, b0, max, lowerBetter]) => {
      const pct = Math.max(2, Math.min(100, (v / max) * 100));
      const diff = +(v - b0).toFixed(3);
      const good = lowerBetter ? diff < 0 : diff > 0;
      const sign = diff === 0 ? '' : (diff > 0 ? '+' : '');
      return `
        <div class="gs-stat">
          <i>${label}</i>
          <div class="gs-stat-bar"><div style="width:${pct}%" data-good="${diff === 0 ? '' : good ? '1' : '0'}"></div></div>
          <b>${fmt(v)}${diff !== 0 ? ` <em data-good="${good ? '1' : '0'}">${sign}${fmt(diff)}</em>` : ''}</b>
        </div>`;
    }).join('')
      + `<div class="gs-ttk">Elimination : <b>${shots} balles</b> au torse
         &middot; <b>${Math.ceil(pool / (now.damage * bal.headMultiplier))}</b> a la tete
         &middot; TTK <b>${((shots - 1) * now.fireInterval).toFixed(2)} s</b></div>`;

    // --- apercu 3D
    const camo = this.cfg.camos.find((c) => c.id === d.camo) || null;
    this.viewer.setWeapon(now.shape, camo, this.user.gunsmith ? d.attachments : {});
    this.resolved = now;
  }

  async _saveLoadout() {
    if (!this.draft || this.user.guest) return;
    this.el.saveHint.textContent = 'Enregistrement...';
    try {
      const res = await Api.saveLoadout({
        slot: this.draft.slot,
        name: this.el.loadoutName.value || 'Classe',
        weapon: this.draft.weapon,
        camo: this.draft.camo,
        attachments: this.draft.attachments,
      });
      // Le serveur renvoie la classe assainie : on l'adopte telle quelle.
      const idx = this.user.loadouts.findIndex((l) => l.slot === res.loadout.slot);
      if (idx >= 0) this.user.loadouts[idx] = res.loadout;
      else this.user.loadouts.push(res.loadout);
      this._renderSlots();
      this._loadDraft(res.loadout.slot);
      this.el.saveHint.textContent = 'Classe enregistree.';
      setTimeout(() => { this.el.saveHint.textContent = ''; }, 2200);
    } catch (e) {
      this.el.saveHint.textContent = e.message;
    }
  }

  /* ------------------------------------------------------------ lancer */

  _start() {
    const online = this.el.online.checked;
    this.onPlay?.({
      mode: this.mode,
      bots: this.el.bots.checked,
      skill: +this.el.skill.value / 100,
      online,
      server: this.el.server.value.trim(),
      slot: this.activeSlot,
      loadout: {
        name: this.draft.name,
        weapon: this.draft.weapon,
        camo: this.draft.camo,
        attachments: this.user.gunsmith ? this.draft.attachments : {},
      },
      stats: this.resolved,
    });
  }

  show() { this.el.lobby.dataset.on = '1'; }
  hide() { this.el.lobby.dataset.on = '0'; }

  /** Met a jour la progression apres une partie. */
  applyProgression(progression) {
    if (!progression || !this.user) return;
    this.user.level = progression.level;
    this.user.xp = progression.xp;
    this.user.xpNext = progression.xpNext;
    this.user.gunsmith = progression.level >= 5;
    this._renderProgress();
    this._renderGunsmith();
  }

  setHint(text) { this.el.playHint.textContent = text || ''; }
}

/* ----------------------------------------------------------- utilitaires */

function fmt(v) {
  if (Math.abs(v) >= 100) return String(Math.round(v));
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2).replace(/\.?0+$/, '');
}

function describeMods(mods) {
  const labels = {
    adsTime: 'visee', spreadAds: 'dispersion visee', spreadHip: 'dispersion hanche',
    recoilVert: 'recul vertical', recoilHoriz: 'recul lateral', rangeFull: 'portee',
    rangeFalloff: 'portee max', mobility: 'mobilite', magazine: 'chargeur',
    reloadTime: 'rechargement', zoom: 'grossissement', spreadMoveMul: 'dispersion en mouvement',
    silent: 'discretion', visibleLaser: 'laser visible',
  };
  return Object.entries(mods)
    .map(([k, v]) => `${labels[k] || k} ${typeof v === 'number' ? (v > 0 ? '+' : '') + fmt(v) : ''}`)
    .join(' / ');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
