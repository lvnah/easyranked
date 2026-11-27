/**
 * EasyRanked :: moteur de rendu.
 *
 * Choix de performance (cible : framerate tres eleve sur GPU recent) :
 *  - aucun post-traitement : le cout d'un EffectComposer plein ecran est le
 *    premier poste a sauter quand on vise >200 FPS ;
 *  - une seule ombre portee directionnelle, dont le frustum suit le joueur
 *    (shadow map 2048 "glissante" au lieu de couvrir 84x64 m) ;
 *  - decors statiques en InstancedMesh, matrixAutoUpdate desactive ;
 *  - pools pre-alloues pour impacts, traceuses, flashs et particules :
 *    zero allocation pendant le combat ;
 *  - resolution adaptative : le devicePixelRatio baisse si le GPU decroche.
 */
import * as THREE from 'three';
import { material, sprite, skyTexture, setAnisotropy } from './textures.js';

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || 'high';

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = this.quality !== 'low';
    this.renderer.shadowMap.type = this.quality === 'high'
      ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.renderer.info.autoReset = false;

    setAnisotropy(Math.min(8, this.renderer.capabilities.getMaxAnisotropy()));

    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 2 : 1.25);
    this.pixelRatio = this.maxPixelRatio;

    this.scene = new THREE.Scene();
    // Deux cameras : le monde, et une camera dediee a l'arme en 1ere personne
    // (champ de vision reduit, near tres court -> l'arme ne traverse pas les murs).
    this.camera = new THREE.PerspectiveCamera(80, 1, 0.08, 320);
    this.viewModelCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 6);
    this.viewModelScene = new THREE.Scene();

    this.clock = new THREE.Clock();
    this.frame = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._adaptAcc = 0;

    this.pools = {};
    this._setupEnvironment(opts.arena);
    this._setupPools();

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /* ------------------------------------------------------- environnement */

  _setupEnvironment(arena) {
    const sunCfg = arena?.sun || { dir: [-0.62, 0.3, 0.72], color: 0xfff1d8, intensity: 3.0,
                                   ambient: 0x6f7d8c, ambientIntensity: 0.9 };
    const fogCfg = arena?.fog || { color: 0xbfc8d2, near: 34, far: 185 };

    this.scene.background = skyTexture(512);
    this.scene.environment = this.scene.background;
    this.scene.environmentIntensity = 0.55;
    // Brouillard atmospherique leger : donne la profondeur sans masquer les cibles.
    this.scene.fog = new THREE.Fog(fogCfg.color, fogCfg.near, fogCfg.far);

    // Lumiere du jour rasante : l'ombre est nette et tres allongee.
    this.sun = new THREE.DirectionalLight(sunCfg.color, sunCfg.intensity);
    this.sunDir = new THREE.Vector3(sunCfg.dir[0], sunCfg.dir[1], sunCfg.dir[2]).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(60);
    this.sun.castShadow = this.renderer.shadowMap.enabled;
    const shadowSize = this.quality === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    // Frustum serre autour du joueur -> beaucoup plus de texels par metre.
    const extent = 26;
    Object.assign(this.sun.shadow.camera, {
      left: -extent, right: extent, top: extent, bottom: -extent, near: 1, far: 140,
    });
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.022;
    this.sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.ambient = new THREE.HemisphereLight(0xdce6f0, sunCfg.ambient, sunCfg.ambientIntensity);
    this.scene.add(this.ambient);
    // Rebond chaud du sol, cote oppose au soleil (evite les ombres totalement noires).
    this.bounce = new THREE.DirectionalLight(0xffc89a, 0.35);
    this.bounce.position.copy(this.sunDir).multiplyScalar(-40).setY(8);
    this.scene.add(this.bounce);

    // L'arme est eclairee dans sa propre scene, avec les memes directions.
    const vmKey = new THREE.DirectionalLight(sunCfg.color, 2.1);
    vmKey.position.set(-0.6, 1.2, 0.8);
    this.viewModelScene.add(vmKey);
    const vmFill = new THREE.HemisphereLight(0xdce6f0, 0x50565c, 1.15);
    this.viewModelScene.add(vmFill);
    this.viewModelScene.environment = this.scene.environment;
    this.viewModelScene.environmentIntensity = 0.4;
  }

  /** Recentre la shadow map sur le joueur (appele chaque frame). */
  followShadow(target) {
    this.sun.target.position.set(target.x, 0, target.z);
    this.sun.position.set(
      target.x + this.sunDir.x * 55,
      this.sunDir.y * 55 + 10,
      target.z + this.sunDir.z * 55
    );
    this.sun.target.updateMatrixWorld();
  }

  /* --------------------------------------------------------------- pools */

  _setupPools() {
    // Chaque objet d'un pool recoit SON materiau (clone du modele) : l'opacite
    // est animee par particule, un materiau partage les ferait toutes disparaitre
    // ensemble. Les clones partagent texture et programme GPU, le surcout est
    // limite aux uniformes.
    const impactMat = new THREE.MeshBasicMaterial({
      map: sprite('hole'), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, opacity: 0.95,
    });
    const impactGeo = new THREE.PlaneGeometry(0.1, 0.1);
    this.pools.impacts = new Pool(160, () => {
      const m = new THREE.Mesh(impactGeo, impactMat.clone());
      m.renderOrder = 2;
      return m;
    }, this.scene);

    // --- traceuses : segments etires selon la trajectoire
    const tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0, transparent: true, opacity: 0.75, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const tracerGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    tracerGeo.rotateX(Math.PI / 2);
    tracerGeo.translate(0, 0, -0.5);
    this.pools.tracers = new Pool(48, () => new THREE.Mesh(tracerGeo, tracerMat.clone()), this.scene);

    // --- flashs de bouche (billboards additifs)
    const flashMat = new THREE.SpriteMaterial({
      map: sprite('spark'), color: 0xffd48a, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    });
    this.pools.flashes = new Pool(16, () => {
      const s = new THREE.Sprite(flashMat.clone());
      s.renderOrder = 10;
      return s;
    }, this.scene);

    // --- etincelles / poussiere / sang
    const sparkMat = new THREE.SpriteMaterial({
      map: sprite('spark'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const smokeMat = new THREE.SpriteMaterial({
      map: sprite('smoke'), transparent: true, depthWrite: false, opacity: 0.5,
    });
    const bloodMat = new THREE.SpriteMaterial({
      map: sprite('spark'), color: 0x8c1414, transparent: true, depthWrite: false,
    });
    this.pools.sparks = new Pool(220, () => new THREE.Sprite(sparkMat.clone()), this.scene);
    this.pools.smoke = new Pool(90, () => new THREE.Sprite(smokeMat.clone()), this.scene);
    this.pools.blood = new Pool(120, () => new THREE.Sprite(bloodMat.clone()), this.scene);

    this.particles = [];     // tableau dense, balaye chaque frame
  }

  /** Impact de balle : trou + poussiere + etincelles. */
  spawnImpact(point, normal, kind = 'concrete') {
    const hole = this.pools.impacts.take();
    if (hole) {
      hole.position.copy(point).addScaledVector(normal, 0.012);
      hole.lookAt(point.clone().add(normal));
      const s = 0.07 + Math.random() * 0.05;
      hole.scale.set(s, s, s);
      hole.material.opacity = 0.95;
      this.particles.push({ obj: hole, pool: this.pools.impacts, life: 14, max: 14, kind: 'decal' });
    }
    const dust = kind === 'flesh' ? this.pools.blood : this.pools.smoke;
    for (let i = 0; i < (kind === 'flesh' ? 7 : 4); i++) {
      const p = dust.take();
      if (!p) break;
      p.position.copy(point);
      const sc = kind === 'flesh' ? 0.07 : 0.11;
      p.scale.setScalar(sc);
      p.material.opacity = 0.55;
      this.particles.push({
        obj: p, pool: dust, life: 0.55 + Math.random() * 0.4, max: 1.0, kind: 'puff',
        vel: new THREE.Vector3(
          normal.x * 1.2 + (Math.random() - 0.5) * 1.4,
          normal.y * 0.8 + Math.random() * 1.6,
          normal.z * 1.2 + (Math.random() - 0.5) * 1.4
        ),
        grow: kind === 'flesh' ? 0.6 : 2.4,
      });
    }
    if (kind !== 'flesh') {
      for (let i = 0; i < 5; i++) {
        const s = this.pools.sparks.take();
        if (!s) break;
        s.position.copy(point);
        s.scale.setScalar(0.035);
        s.material.opacity = 1;
        this.particles.push({
          obj: s, pool: this.pools.sparks, life: 0.18 + Math.random() * 0.22, max: 0.4, kind: 'spark',
          vel: new THREE.Vector3(
            normal.x * 3 + (Math.random() - 0.5) * 5,
            normal.y * 2 + Math.random() * 3,
            normal.z * 3 + (Math.random() - 0.5) * 5
          ),
          grow: -0.02,
        });
      }
    }
  }

  /** Traceuse : un segment qui s'efface en ~60 ms. */
  spawnTracer(from, to) {
    const t = this.pools.tracers.take();
    if (!t) return;
    const dist = from.distanceTo(to);
    if (dist < 0.4) { this.pools.tracers.give(t); return; }
    t.position.copy(from);
    t.lookAt(to);
    t.scale.set(1, 1, dist);
    t.material.opacity = 0.75;
    this.particles.push({ obj: t, pool: this.pools.tracers, life: 0.06, max: 0.06, kind: 'tracer' });
  }

  /** Flash de bouche. */
  spawnFlash(point, scale = 0.42) {
    const f = this.pools.flashes.take();
    if (!f) return;
    f.position.copy(point);
    f.scale.setScalar(scale * (0.82 + Math.random() * 0.4));
    f.material.rotation = Math.random() * Math.PI * 2;
    this.particles.push({ obj: f, pool: this.pools.flashes, life: 0.045, max: 0.045, kind: 'flash' });
  }

  /** Explosion de grenade : boule de feu, fumee, eclats. */
  spawnExplosion(point) {
    for (let i = 0; i < 16; i++) {
      const s = this.pools.sparks.take();
      if (!s) break;
      s.position.copy(point);
      s.scale.setScalar(0.3 + Math.random() * 0.5);
      s.material.opacity = 1;
      this.particles.push({
        obj: s, pool: this.pools.sparks, life: 0.3 + Math.random() * 0.4, max: 0.7, kind: 'spark',
        vel: new THREE.Vector3((Math.random() - 0.5) * 9, Math.random() * 7, (Math.random() - 0.5) * 9),
        grow: 1.2,
      });
    }
    for (let i = 0; i < 14; i++) {
      const p = this.pools.smoke.take();
      if (!p) break;
      p.position.copy(point);
      p.scale.setScalar(0.5 + Math.random() * 0.7);
      p.material.opacity = 0.6;
      this.particles.push({
        obj: p, pool: this.pools.smoke, life: 1.4 + Math.random() * 1.2, max: 2.6, kind: 'puff',
        vel: new THREE.Vector3((Math.random() - 0.5) * 3.5, 1.2 + Math.random() * 2.4, (Math.random() - 0.5) * 3.5),
        grow: 2.6,
      });
    }
  }

  /** Avance toutes les particules et rend leurs objets au pool. */
  updateParticles(dt) {
    const list = this.particles;
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.life -= p.kind === 'decal' ? dt * 0.35 : dt;
      if (p.life <= 0) {
        p.pool.give(p.obj);
        // Suppression O(1) : on remplace par le dernier element.
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      const k = p.life / p.max;
      if (p.vel) {
        p.obj.position.addScaledVector(p.vel, dt);
        p.vel.y -= (p.kind === 'spark' ? 11 : 1.4) * dt;
        p.vel.multiplyScalar(1 - 2.2 * dt);
      }
      if (p.grow) p.obj.scale.addScalar(p.grow * dt * 0.1);
      if (p.kind === 'decal') {
        p.obj.material.opacity = Math.min(0.95, k * 3);
      } else if (p.obj.material.opacity !== undefined) {
        p.obj.material.opacity = (p.kind === 'puff' ? 0.55 : 1) * k;
      }
    }
  }

  /* ------------------------------------------------------------ rendu */

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewModelCamera.aspect = aspect;
    this.viewModelCamera.updateProjectionMatrix();
  }

  /** Abaisse la resolution interne si le GPU ne tient pas la cadence. */
  _adaptResolution(dt) {
    this._adaptAcc += dt;
    if (this._adaptAcc < 1.0) return;
    this._adaptAcc = 0;
    if (this.fps < 55 && this.pixelRatio > 0.7) {
      this.pixelRatio = Math.max(0.7, this.pixelRatio - 0.15);
      this.resize();
    } else if (this.fps > 140 && this.pixelRatio < this.maxPixelRatio) {
      this.pixelRatio = Math.min(this.maxPixelRatio, this.pixelRatio + 0.1);
      this.resize();
    }
  }

  render(dt) {
    this.frame++;
    this._fpsAcc += dt;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = Math.round(this._fpsFrames / this._fpsAcc);
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
    this._adaptResolution(dt);

    this.renderer.info.reset();
    this.renderer.render(this.scene, this.camera);
    // L'arme est rendue par-dessus, avec son propre depth buffer.
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.viewModelScene, this.viewModelCamera);
    this.renderer.autoClear = true;
  }

  stats() {
    const info = this.renderer.info;
    return {
      fps: this.fps,
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      pixelRatio: Math.round(this.pixelRatio * 100) / 100,
      particles: this.particles.length,
    };
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}

/** Pool d'objets pre-alloues : aucune allocation pendant le jeu. */
class Pool {
  constructor(size, factory, parent) {
    this.free = [];
    this.parent = parent;
    for (let i = 0; i < size; i++) {
      const o = factory();
      o.visible = false;
      o.matrixAutoUpdate = true;
      parent.add(o);
      this.free.push(o);
    }
  }
  take() {
    const o = this.free.pop();
    if (!o) return null;        // pool epuise : on saute l'effet plutot que d'allouer
    o.visible = true;
    return o;
  }
  give(o) {
    o.visible = false;
    this.free.push(o);
  }
}
