/**
 * EasyRanked :: utilitaires de geometrie procedurale.
 *
 * Les modeles sont assembles a partir de dizaines de primitives ; sans fusion
 * cela ferait des centaines d'appels de rendu par personnage. `finalize()`
 * fusionne les primitives d'un groupe par materiau, en conservant la
 * hierarchie necessaire a l'animation (hanches / buste / membres).
 */
import * as THREE from 'three';

/* --------------------------------------------------------------- primitives */

const geoCache = new Map();
function cached(key, build) {
  let g = geoCache.get(key);
  if (!g) { g = build(); geoCache.set(key, g); }
  return g;
}

export const box = (w, h, d, s = 1) =>
  cached(`b${w},${h},${d},${s}`, () => new THREE.BoxGeometry(w, h, d, s, s, s));
export const cyl = (rt, rb, h, seg = 12, open = false) =>
  cached(`c${rt},${rb},${h},${seg},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open));
export const sph = (r, wseg = 14, hseg = 10) =>
  cached(`s${r},${wseg},${hseg}`, () => new THREE.SphereGeometry(r, wseg, hseg));
export const cap = (r, len, seg = 8, rings = 5) =>
  cached(`p${r},${len},${seg},${rings}`, () => new THREE.CapsuleGeometry(r, len, rings, seg));
export const cone = (r, h, seg = 10) =>
  cached(`n${r},${h},${seg}`, () => new THREE.ConeGeometry(r, h, seg));
export const torus = (r, tube, rad = 8, tub = 14) =>
  cached(`t${r},${tube},${rad},${tub}`, () => new THREE.TorusGeometry(r, tube, rad, tub));

/* ------------------------------------------------------------------ pose */

/**
 * Ajoute une primitive dans un groupe, positionnee/orientee/mise a l'echelle.
 * @param {THREE.Object3D} parent
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.Material} material
 * @param {object} t  { pos:[x,y,z], rot:[x,y,z], scale:[x,y,z]|number }
 */
export function piece(parent, geometry, material, t = {}) {
  const m = new THREE.Mesh(geometry, material);
  if (t.pos) m.position.set(t.pos[0], t.pos[1], t.pos[2]);
  if (t.rot) m.rotation.set(t.rot[0], t.rot[1], t.rot[2]);
  if (t.scale !== undefined) {
    const s = t.scale;
    Array.isArray(s) ? m.scale.set(s[0], s[1], s[2]) : m.scale.setScalar(s);
  }
  m.castShadow = t.shadow !== false;
  m.receiveShadow = t.receive !== false;
  parent.add(m);
  return m;
}

/* ----------------------------------------------------------------- fusion */

/** Concatene des geometries non indexees partageant les memes attributs. */
export function mergeGeometries(geometries) {
  if (geometries.length === 1) return geometries[0];
  const list = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  const attrs = ['position', 'normal', 'uv'];
  let total = 0;
  for (const g of list) total += g.attributes.position.count;

  const out = new THREE.BufferGeometry();
  for (const name of attrs) {
    const size = name === 'uv' ? 2 : 3;
    const arr = new Float32Array(total * size);
    let offset = 0;
    for (const g of list) {
      const a = g.attributes[name];
      const count = g.attributes.position.count;
      if (a) {
        arr.set(a.array.subarray(0, count * size), offset);
      } // pas d'attribut -> zeros (ne concerne que des geometries degenerees
      offset += count * size;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

/**
 * Fusionne, par materiau, toutes les primitives filles directes d'un groupe.
 * Les sous-groupes (articulations) sont preserves et traites recursivement.
 * @returns {THREE.Object3D} le groupe lui-meme, modifie en place
 */
export function finalize(group) {
  const children = [...group.children];
  const buckets = new Map();
  const keep = [];

  for (const child of children) {
    if (child.isMesh && !child.userData.noMerge) {
      const key = child.material.uuid;
      let b = buckets.get(key);
      if (!b) { b = { material: child.material, geos: [], shadow: child.castShadow }; buckets.set(key, b); }
      child.updateMatrix();
      const g = child.geometry.clone().applyMatrix4(child.matrix);
      g.computeVertexNormals();
      b.geos.push(g);
    } else {
      keep.push(child);
      if (child.isGroup || child.isObject3D) finalize(child);
    }
  }

  group.clear();
  for (const child of keep) group.add(child);
  for (const b of buckets.values()) {
    const mesh = new THREE.Mesh(mergeGeometries(b.geos), b.material);
    mesh.castShadow = b.shadow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/** Compte les appels de rendu d'une hierarchie (diagnostic). */
export function countMeshes(root) {
  let n = 0, tris = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    n++;
    const pos = o.geometry.attributes.position;
    tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
  });
  return { meshes: n, triangles: Math.round(tris) };
}

/** Clone profond en partageant geometries et materiaux (instances legeres). */
export function cloneShared(root) {
  const copy = root.clone(true);
  copy.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return copy;
}
