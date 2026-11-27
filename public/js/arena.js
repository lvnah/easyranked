/**
 * EasyRanked :: construction de l'arene "Foundry" depuis shared/arena.json.
 *
 * Le meme fichier sert au serveur (validation des tirs, navigation des bots) :
 * la geometrie de collision du client est donc exactement celle du serveur.
 */
import * as THREE from 'three';
import { material } from './textures.js';
import { mergeGeometries } from './geo.js';
import { buildCrate, buildBarrel, buildPallet, buildDebris, buildVehicle, buildJersey, buildContainer }
  from './visuals.js';

export class Arena {
  /**
   * @param {object} data  contenu de shared/arena.json
   * @param {THREE.Scene} scene
   */
  constructor(data, scene) {
    this.data = data;
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'arena';
    scene.add(this.root);

    /** @type {Array<{min:THREE.Vector3,max:THREE.Vector3,mat:string}>} AABB de collision */
    this.colliders = [];
    this.bounds = data.bounds;

    this._buildGround();
    this._buildSolids();
    this._buildDecor();
    this._buildInstanced();
    this._buildLights();

    // Les decors ne bougent jamais : on economise les recalculs de matrices.
    this.root.traverse((o) => {
      o.matrixAutoUpdate = false;
      o.updateMatrix();
    });
    this.root.updateMatrixWorld(true);
  }

  /* ---------------------------------------------------------------- sol */

  _buildGround() {
    const { w, d } = this.bounds;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d, 1, 1),
      material('asphalt', { repeat: [w / 4, d / 4], normalScale: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.root.add(ground);

    // Dalles de beton : grandes zones claires qui cassent l'uniformite du bitume.
    for (const p of this.data.patches || []) {
      const slab = new THREE.Mesh(
        new THREE.PlaneGeometry(p.size[0], p.size[1]),
        material(p.mat, { repeat: [p.size[0] / 5, p.size[1] / 5] })
      );
      slab.rotation.x = -Math.PI / 2;
      slab.position.set(p.pos[0], p.pos[1], p.pos[2]);
      slab.receiveShadow = true;
      this.root.add(slab);
    }
  }

  /* ------------------------------------------------------------- solides */

  _buildSolids() {
    // Les boites simples partageant un materiau sont fusionnees en un seul mesh :
    // 40 murs de brique -> 1 appel de rendu.
    const batches = new Map();

    for (const s of this.data.solids) {
      if (s.collide !== false) this._addCollider(s);

      if (s.kind === 'vehicle') {
        const v = buildVehicle(s.sub, s.mat);
        v.position.set(s.pos[0], s.pos[1], s.pos[2]);
        v.rotation.y = s.ry || 0;
        this.root.add(v);
        continue;
      }
      if (s.detail === 'container') {
        const c = buildContainer(s.size[0], s.size[1], s.size[2], s.mat);
        c.position.set(s.pos[0], s.pos[1], s.pos[2]);
        this.root.add(c);
        continue;
      }
      if (s.detail === 'jersey') {
        const j = buildJersey(s.size[0], s.size[1], s.size[2]);
        j.position.set(s.pos[0], s.pos[1], s.pos[2]);
        this.root.add(j);
        continue;
      }

      const tile = s.tile || [Math.max(1, s.size[0] / 2), Math.max(1, s.size[1] / 2)];
      const key = `${s.mat}|${tile[0].toFixed(2)}x${tile[1].toFixed(2)}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { mat: material(s.mat, { repeat: tile }), geos: [], shadow: s.shadow !== false };
        batches.set(key, batch);
      }
      const g = new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
      const m = new THREE.Matrix4()
        .makeRotationY(s.ry || 0)
        .setPosition(s.pos[0], s.pos[1], s.pos[2]);
      batch.geos.push(g.applyMatrix4(m));
    }

    for (const batch of batches.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(batch.geos), batch.mat);
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
  }

  _buildDecor() {
    const batches = new Map();
    for (const s of this.data.decor || []) {
      if (s.kind === 'skylight') {
        // Verriere : plaque translucide sur la toiture (lumiere rasante filtree).
        const glass = new THREE.Mesh(
          new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]),
          new THREE.MeshPhysicalMaterial({
            color: 0xd8e4ea, metalness: 0.0, roughness: 0.22,
            transmission: 0.72, thickness: 0.05, ior: 1.45,
            transparent: true, opacity: 0.55, side: THREE.DoubleSide,
          })
        );
        glass.position.set(s.pos[0], s.pos[1], s.pos[2]);
        this.root.add(glass);
        // Meneaux metalliques.
        const bars = [];
        const n = Math.max(2, Math.round(s.size[2] / 2.4));
        for (let i = 0; i < n; i++) {
          const g = new THREE.BoxGeometry(s.size[0] + 0.1, 0.1, 0.1);
          g.translate(s.pos[0], s.pos[1] + 0.06, s.pos[2] - s.size[2] / 2 + (i + 0.5) * (s.size[2] / n));
          bars.push(g);
        }
        const frame = new THREE.Mesh(mergeGeometries(bars), material('steel', { repeat: [2, 1] }));
        frame.castShadow = true;
        this.root.add(frame);
        continue;
      }
      const tile = s.tile || [Math.max(1, s.size[0] / 2), Math.max(1, s.size[1] / 2)];
      const key = `${s.mat}|${tile[0].toFixed(2)}x${tile[1].toFixed(2)}|${s.shadow !== false}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = { mat: material(s.mat, { repeat: tile }), geos: [], shadow: s.shadow !== false };
        batches.set(key, batch);
      }
      const g = new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]);
      g.applyMatrix4(new THREE.Matrix4().makeRotationY(s.ry || 0).setPosition(s.pos[0], s.pos[1], s.pos[2]));
      batch.geos.push(g);
    }
    for (const batch of batches.values()) {
      const mesh = new THREE.Mesh(mergeGeometries(batch.geos), batch.mat);
      mesh.castShadow = batch.shadow;
      mesh.receiveShadow = true;
      this.root.add(mesh);
    }
  }

  /* ------------------------------------------------------- props instancies */

  _buildInstanced() {
    const builders = { crate: buildCrate, barrel: buildBarrel, pallet: buildPallet, debris: buildDebris };

    for (const grp of this.data.instanced || []) {
      const build = builders[grp.kind];
      if (!build || grp.transforms.length === 0) continue;

      // Le prototype est construit une fois, puis instancie : une seule
      // geometrie et un seul materiau en memoire pour N exemplaires.
      const proto = build();
      const parts = [];
      proto.traverse((o) => { if (o.isMesh) parts.push(o); });

      for (const part of parts) {
        part.updateMatrixWorld(true);
        const geo = part.geometry.clone().applyMatrix4(part.matrixWorld);
        const inst = new THREE.InstancedMesh(geo, part.material, grp.transforms.length);
        inst.castShadow = part.castShadow;
        inst.receiveShadow = true;
        inst.instanceMatrix.setUsage(THREE.StaticDrawUsage);
        const m = new THREE.Matrix4();
        const q = new THREE.Quaternion();
        const pos = new THREE.Vector3();
        const scl = new THREE.Vector3();
        grp.transforms.forEach((t, i) => {
          pos.set(t[0], t[1], t[2]);
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), t[3] || 0);
          scl.setScalar(t[4] ?? 1);
          inst.setMatrixAt(i, m.compose(pos, q, scl));
        });
        inst.instanceMatrix.needsUpdate = true;
        inst.computeBoundingSphere();
        this.root.add(inst);
      }

      if (grp.collide) {
        const r = grp.radius ?? 0.5;
        for (const t of grp.transforms) {
          const h = grp.kind === 'barrel' ? 1.16 : 0.9 * (t[4] ?? 1);
          const rr = r * (grp.kind === 'barrel' ? 1 : (t[4] ?? 1));
          this.colliders.push({
            min: new THREE.Vector3(t[0] - rr, 0, t[2] - rr),
            max: new THREE.Vector3(t[0] + rr, h, t[2] + rr),
            mat: grp.kind === 'barrel' ? 'metal' : 'wood',
          });
        }
      }
    }
  }

  _buildLights() {
    // Peu de lumieres ponctuelles, sans ombre : le cout serait prohibitif.
    for (const l of this.data.lights || []) {
      const light = new THREE.PointLight(l.color, l.intensity, l.distance, 2);
      light.position.set(l.pos[0], l.pos[1], l.pos[2]);
      light.castShadow = false;
      this.root.add(light);
    }
  }

  /* --------------------------------------------------------- collision */

  _addCollider(s) {
    let [w, h, d] = s.size;
    if (Math.abs(Math.sin(s.ry || 0)) > 0.5) [w, d] = [d, w];
    this.colliders.push({
      min: new THREE.Vector3(s.pos[0] - w / 2, s.pos[1] - h / 2, s.pos[2] - d / 2),
      max: new THREE.Vector3(s.pos[0] + w / 2, s.pos[1] + h / 2, s.pos[2] + d / 2),
      mat: s.mat,
    });
  }

  /** Point de reapparition de l'equipe donnee (utilise hors ligne). */
  spawn(team, index = -1) {
    const list = this.data.spawns[String(team)] || this.data.spawns[team] || [[0, 0, 0]];
    const s = list[index >= 0 ? index % list.length : Math.floor(Math.random() * list.length)];
    return new THREE.Vector3(s[0], 0, s[2]);
  }

  waypoints() {
    return this.data.waypoints;
  }

  stats() {
    let meshes = 0, instances = 0;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      if (o.isInstancedMesh) instances += o.count;
    });
    return { meshes, instances, colliders: this.colliders.length };
  }
}
