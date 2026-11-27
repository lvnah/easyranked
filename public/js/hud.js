/**
 * EasyRanked :: interface de jeu.
 *
 * Disposition reprise de la reference :
 *   - haut gauche  : icone d'equipe, barre de vie / bouclier, score
 *   - bas droite   : silhouette de l'arme, munitions (chargeur / reserve),
 *                    icone et compteur de grenades
 *   - centre       : viseur dynamique + hitmarkers
 *
 * Tout est en DOM/CSS (le texte en canvas coute plus cher a rafraichir), sauf
 * la silhouette de l'arme, dessinee une fois par changement d'arme.
 */

export class Hud {
  constructor(rootEl) {
    this.root = rootEl;
    this.el = {};
    this._build();
    this._last = {};
    this.hitQueue = [];
    this.killfeed = [];
    this.spread = 0;
    this.damageDirections = [];
  }

  _build() {
    this.root.innerHTML = `
      <div class="hud" id="hud">
        <!-- ------------------------------------------------ haut gauche -->
        <div class="hud-tl">
          <div class="hud-id">
            <div class="team-badge" id="hudTeamBadge"><span id="hudTeamIcon">A</span></div>
            <div class="hud-id-text">
              <div class="hud-name" id="hudName">OPERATEUR</div>
              <div class="hud-rank"><i>NIV</i><span id="hudLevel">1</span></div>
            </div>
          </div>
          <div class="hud-bars">
            <div class="bar bar-shield"><div class="bar-fill" id="hudShield"></div></div>
            <div class="bar bar-health">
              <div class="bar-fill" id="hudHealth"></div>
              <span class="bar-text" id="hudHealthText">150</span>
            </div>
          </div>
          <div class="hud-score">
            <div class="score-side score-a"><span id="hudScoreA">0</span></div>
            <div class="score-sep" id="hudTimer">--:--</div>
            <div class="score-side score-b"><span id="hudScoreB">0</span></div>
          </div>
        </div>

        <!-- ------------------------------------------------- bas droite -->
        <div class="hud-br">
          <div class="weapon-block">
            <canvas class="weapon-silhouette" id="hudWeaponCanvas" width="320" height="96"></canvas>
            <div class="weapon-name" id="hudWeaponName">MK18</div>
            <div class="ammo-row">
              <span class="ammo-mag" id="hudAmmoMag">30</span>
              <span class="ammo-sep">/</span>
              <span class="ammo-reserve" id="hudAmmoReserve">150</span>
            </div>
            <div class="ammo-pips" id="hudAmmoPips"></div>
          </div>
          <div class="nade-block" id="hudNadeBlock">
            <svg class="nade-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 3h6v2h-2v1.2A7 7 0 1 1 11 6.2V5H9V3z" fill="currentColor"/>
              <circle cx="12" cy="13.4" r="4.4" fill="none" stroke="rgba(0,0,0,.45)" stroke-width="1.2"/>
              <path d="M16.6 4.4l2.6-1.3 1 2-2.6 1.3z" fill="currentColor"/>
            </svg>
            <span class="nade-count" id="hudNadeCount">2</span>
          </div>
        </div>

        <!-- --------------------------------------------------- centre -->
        <div class="crosshair" id="hudCrosshair">
          <i class="ch-dot"></i>
          <i class="ch-line ch-up"></i><i class="ch-line ch-down"></i>
          <i class="ch-line ch-left"></i><i class="ch-line ch-right"></i>
        </div>
        <div class="hitmarker" id="hudHitmarker"><i></i><i></i><i></i><i></i></div>
        <div class="scope-overlay" id="hudScope"><div class="scope-ring"></div></div>

        <!-- ------------------------------------------------- annexes -->
        <div class="killfeed" id="hudKillfeed"></div>
        <div class="hud-center-msg" id="hudCenterMsg"></div>
        <div class="damage-vignette" id="hudVignette"></div>
        <div class="damage-dirs" id="hudDamageDirs"></div>
        <div class="hud-bl">
          <div class="perf" id="hudPerf"></div>
          <div class="chatlog" id="hudChat"></div>
        </div>
        <div class="scoreboard" id="hudScoreboard"></div>
      </div>`;

    const id = (k) => this.root.querySelector('#' + k);
    this.el = {
      hud: id('hud'),
      teamBadge: id('hudTeamBadge'), teamIcon: id('hudTeamIcon'),
      name: id('hudName'), level: id('hudLevel'),
      health: id('hudHealth'), healthText: id('hudHealthText'), shield: id('hudShield'),
      scoreA: id('hudScoreA'), scoreB: id('hudScoreB'), timer: id('hudTimer'),
      weaponCanvas: id('hudWeaponCanvas'), weaponName: id('hudWeaponName'),
      ammoMag: id('hudAmmoMag'), ammoReserve: id('hudAmmoReserve'), ammoPips: id('hudAmmoPips'),
      nadeCount: id('hudNadeCount'), nadeBlock: id('hudNadeBlock'),
      crosshair: id('hudCrosshair'), hitmarker: id('hudHitmarker'), scope: id('hudScope'),
      killfeed: id('hudKillfeed'), centerMsg: id('hudCenterMsg'),
      vignette: id('hudVignette'), damageDirs: id('hudDamageDirs'),
      perf: id('hudPerf'), chat: id('hudChat'), scoreboard: id('hudScoreboard'),
    };
  }

  /* ----------------------------------------------------------- identite */

  setIdentity({ name, level, team }) {
    this.el.name.textContent = (name || 'OPERATEUR').toUpperCase();
    this.el.level.textContent = level ?? 1;
    this.el.teamIcon.textContent = team === 1 ? 'B' : 'A';
    this.el.teamBadge.dataset.team = team === 1 ? 'b' : 'a';
    this.el.hud.dataset.team = team === 1 ? 'b' : 'a';
  }

  /* ------------------------------------------------- silhouette de l'arme */

  /**
   * Dessine la silhouette 2D de l'arme active (avec ses accessoires).
   * Un vrai rendu 3D en vignette couterait une passe de plus par frame.
   */
  setWeapon(cfg, attachments = {}) {
    this.el.weaponName.textContent = (cfg.name || '').toUpperCase();
    const c = this.el.weaponCanvas;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(14, 60);

    const styles = {
      carbine: { rec: 110, hg: 86, stock: 58, magW: 22, magH: 34, curve: 5 },
      smg:     { rec: 92,  hg: 56, stock: 44, magW: 20, magH: 40, curve: 9 },
      ak:      { rec: 116, hg: 76, stock: 62, magW: 24, magH: 40, curve: 18 },
      dmr:     { rec: 128, hg: 104, stock: 66, magW: 20, magH: 30, curve: 4 },
    };
    const s = styles[cfg.shape] || styles.carbine;
    const fill = 'rgba(232,238,244,0.92)';
    const dim = 'rgba(232,238,244,0.55)';

    const rr = (x, y, w, h, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      ctx.fill();
    };

    // Crosse (plus epaisse si crosse lourde).
    const stockH = attachments.stock === 'heavy' ? 22 : attachments.stock === 'light' ? 12 : 17;
    rr(s.rec - 6, -stockH / 2 - 1, s.stock, stockH, 3, dim);
    rr(s.rec + s.stock - 14, -13, 7, 26, 2, dim);
    // Boitier de culasse.
    rr(0, -13, s.rec, 26, 3, fill);
    // Garde-main + canon.
    rr(-s.hg, -8, s.hg + 4, 16, 3, fill);
    const barrelExtra = attachments.barrel === 'long' ? 26 : attachments.barrel === 'short' ? -8 : 0;
    const bx = -s.hg - 14 - barrelExtra;
    rr(bx, -3, Math.max(8, 16 + barrelExtra), 6, 2, fill);
    // Bouche.
    if (attachments.muzzle === 'suppressor') rr(bx - 34, -7, 34, 14, 4, fill);
    else if (attachments.muzzle) rr(bx - 14, -6, 14, 12, 2, fill);
    // Rail + optique.
    rr(-s.hg + 4, -18, s.rec + s.hg - 16, 5, 1, dim);
    if (attachments.optic === 'acog') {
      rr(14, -38, 54, 20, 5, fill);
      rr(8, -40, 10, 24, 3, dim);
    } else if (attachments.optic) {
      rr(22, -34, 30, 16, 4, fill);
    }
    // Poignee pistolet + pontet.
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(s.rec - 30, 12);
    ctx.lineTo(s.rec - 6, 12);
    ctx.lineTo(s.rec - 14, 46);
    ctx.lineTo(s.rec - 34, 44);
    ctx.closePath();
    ctx.fill();
    // Chargeur courbe.
    const magH = s.magH * (attachments.mag === 'ext' ? 1.38 : 1);
    ctx.beginPath();
    ctx.moveTo(s.rec * 0.33, 12);
    ctx.lineTo(s.rec * 0.33 + s.magW, 12);
    ctx.quadraticCurveTo(
      s.rec * 0.33 + s.magW + s.curve, 12 + magH * 0.6,
      s.rec * 0.33 + s.magW + s.curve * 1.4, 12 + magH
    );
    ctx.lineTo(s.rec * 0.33 + s.curve * 1.2, 12 + magH);
    ctx.quadraticCurveTo(s.rec * 0.33 - 1, 12 + magH * 0.6, s.rec * 0.33, 12);
    ctx.closePath();
    ctx.fill();
    // Poignee avant.
    if (attachments.grip === 'vertical') rr(-s.hg * 0.6, 8, 10, 24, 3, fill);
    else if (attachments.grip === 'angled') {
      ctx.save(); ctx.translate(-s.hg * 0.6, 8); ctx.rotate(0.6);
      rr(0, 0, 10, 22, 3, fill); ctx.restore();
    }
    // Laser.
    if (attachments.laser) {
      rr(-s.hg * 0.75, -16, 18, 9, 2, dim);
    }
    ctx.restore();
  }

  /* ------------------------------------------------------------- etats */

  setVitals(health, maxHealth, shield, maxShield) {
    const hp = Math.max(0, Math.round(health));
    if (this._last.hp !== hp) {
      this._last.hp = hp;
      const pct = Math.max(0, Math.min(100, (health / maxHealth) * 100));
      this.el.health.style.width = pct + '%';
      this.el.healthText.textContent = hp;
      this.el.health.dataset.low = pct < 33 ? '1' : '0';
      this.el.vignette.style.opacity = String(Math.max(0, (1 - health / maxHealth) * 0.85));
    }
    const sh = Math.max(0, Math.round(shield || 0));
    if (this._last.shield !== sh) {
      this._last.shield = sh;
      this.el.shield.style.width = Math.min(100, (sh / Math.max(1, maxShield || 50)) * 100) + '%';
    }
  }

  setAmmo(mag, magSize, reserve, reloading) {
    if (this._last.mag !== mag || this._last.reserve !== reserve) {
      this._last.mag = mag;
      this._last.reserve = reserve;
      this.el.ammoMag.textContent = mag;
      this.el.ammoReserve.textContent = reserve;
      this.el.ammoMag.dataset.low = mag <= Math.max(3, magSize * 0.2) ? '1' : '0';

      // Rangee de points : lecture instantanee du chargeur restant.
      if (this._last.magSize !== magSize) {
        this._last.magSize = magSize;
        this.el.ammoPips.innerHTML = Array.from(
          { length: Math.min(40, magSize) }, () => '<i></i>'
        ).join('');
      }
      const pips = this.el.ammoPips.children;
      const shown = Math.round((mag / magSize) * pips.length);
      for (let i = 0; i < pips.length; i++) pips[i].dataset.on = i < shown ? '1' : '0';
    }
    if (this._last.reloading !== reloading) {
      this._last.reloading = reloading;
      this.el.weaponName.dataset.reloading = reloading ? '1' : '0';
    }
  }

  setGrenades(n) {
    if (this._last.nades === n) return;
    this._last.nades = n;
    this.el.nadeCount.textContent = n;
    this.el.nadeBlock.dataset.empty = n <= 0 ? '1' : '0';
  }

  setScore(a, b, secondsLeft) {
    if (this._last.scoreA !== a) { this._last.scoreA = a; this.el.scoreA.textContent = a; }
    if (this._last.scoreB !== b) { this._last.scoreB = b; this.el.scoreB.textContent = b; }
    const t = Math.max(0, secondsLeft | 0);
    const txt = `${String((t / 60) | 0).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    if (this._last.timer !== txt) { this._last.timer = txt; this.el.timer.textContent = txt; }
  }

  /* ------------------------------------------------------------ viseur */

  /**
   * Viseur dynamique : l'ecart des branches suit la dispersion reelle.
   * @param {number} spreadDeg dispersion courante en degres
   * @param {number} ads       0..1
   * @param {boolean} scope    optique grossissante -> on masque le viseur
   */
  setCrosshair(spreadDeg, ads, scope, fovDeg, viewportH) {
    // Conversion angle -> pixels : le viseur represente la vraie zone d'impact.
    const halfFov = (fovDeg * Math.PI) / 360;
    const pxPerRad = (viewportH / 2) / Math.tan(halfFov);
    const gap = Math.max(3, Math.min(70, (spreadDeg * Math.PI / 180) * pxPerRad * 0.5));
    if (Math.abs((this._last.gap ?? -1) - gap) > 0.4) {
      this._last.gap = gap;
      this.el.crosshair.style.setProperty('--gap', gap.toFixed(1) + 'px');
    }
    const hide = scope && ads > 0.75;
    if (this._last.chHidden !== hide) {
      this._last.chHidden = hide;
      this.el.crosshair.dataset.hidden = hide ? '1' : '0';
      this.el.scope.dataset.on = hide ? '1' : '0';
    }
  }

  /** Hitmarker : blanc pour un impact, rouge pour une elimination. */
  hit(kind = 'hit') {
    const el = this.el.hitmarker;
    el.dataset.kind = kind;
    el.dataset.on = '1';
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => { el.dataset.on = '0'; }, kind === 'kill' ? 260 : 150);
  }

  /** Indicateur de direction des degats recus. */
  damageFrom(angleRad) {
    const d = document.createElement('div');
    d.className = 'dmg-dir';
    d.style.transform = `rotate(${angleRad}rad)`;
    this.el.damageDirs.appendChild(d);
    setTimeout(() => d.remove(), 900);
  }

  /* -------------------------------------------------------- killfeed */

  addKill({ killer, victim, headshot, killerTeam, victimTeam, youKiller, youVictim }) {
    const row = document.createElement('div');
    row.className = 'kf-row';
    if (youKiller || youVictim) row.dataset.you = '1';
    row.innerHTML = `
      <span class="kf-name" data-team="${killerTeam === 1 ? 'b' : 'a'}">${escapeHtml(killer)}</span>
      <span class="kf-icon">${headshot ? '&#9678;' : '&#10140;'}</span>
      <span class="kf-name" data-team="${victimTeam === 1 ? 'b' : 'a'}">${escapeHtml(victim)}</span>`;
    this.el.killfeed.prepend(row);
    while (this.el.killfeed.children.length > 5) this.el.killfeed.lastChild.remove();
    setTimeout(() => row.remove(), 6000);
  }

  chat(from, msg, team) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = `<b data-team="${team === 1 ? 'b' : 'a'}">${escapeHtml(from)}</b> ${escapeHtml(msg)}`;
    this.el.chat.appendChild(row);
    while (this.el.chat.children.length > 6) this.el.chat.firstChild.remove();
    setTimeout(() => row.remove(), 9000);
  }

  centerMessage(text, duration = 1800) {
    this.el.centerMsg.textContent = text || '';
    this.el.centerMsg.dataset.on = text ? '1' : '0';
    clearTimeout(this._msgTimer);
    if (text && duration > 0) {
      this._msgTimer = setTimeout(() => { this.el.centerMsg.dataset.on = '0'; }, duration);
    }
  }

  setPerf(stats) {
    if (!this.showPerf) { this.el.perf.textContent = ''; return; }
    this.el.perf.textContent =
      `${stats.fps} FPS | ${stats.calls} draw | ${(stats.triangles / 1000).toFixed(1)}k tris | `
      + `res ${stats.pixelRatio} | ${stats.particles} fx` + (stats.ping ? ` | ${stats.ping} ms` : '');
  }

  /** Tableau des scores (touche Tab). */
  setScoreboard(rows, visible, modeLabel) {
    this.el.scoreboard.dataset.on = visible ? '1' : '0';
    if (!visible) return;
    const team = (t) => rows.filter((r) => r.team === t)
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    const render = (list, label, cls) => `
      <div class="sb-team ${cls}">
        <div class="sb-head"><span>${label}</span><span>E</span><span>M</span><span>DEG</span></div>
        ${list.map((r) => `
          <div class="sb-row" data-you="${r.you ? '1' : '0'}">
            <span class="sb-name">${escapeHtml(r.name)}${r.bot ? ' <i>BOT</i>' : ''}</span>
            <span>${r.kills}</span><span>${r.deaths}</span><span>${Math.round(r.damage || 0)}</span>
          </div>`).join('')}
      </div>`;
    this.el.scoreboard.innerHTML = `
      <div class="sb-title">${escapeHtml(modeLabel || '')}</div>
      ${render(team(0), 'EQUIPE A', 'sb-a')}
      ${render(team(1), 'EQUIPE B', 'sb-b')}`;
  }

  setVisible(v) { this.el.hud.dataset.on = v ? '1' : '0'; }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
