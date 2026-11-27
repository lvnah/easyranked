/**
 * EasyRanked :: generateur de l'arene "Foundry" (zone industrielle/urbaine).
 *  node tools/gen_arena.mjs  ->  shared/arena.json
 *
 * Le JSON produit est la SOURCE UNIQUE DE VERITE : le client l'utilise pour
 * construire la geometrie + la collision, le serveur pour valider les tirs et
 * faire naviguer les bots. Toutes les rotations des volumes solides sont des
 * multiples de 90 degres afin que les AABB restent exactes des deux cotes.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const W = 84;   // largeur X
const D = 64;   // profondeur Z
const WALL_H = 7;

const solids = [];   // volumes avec collision
const decor = [];    // volumes purement visuels (rotation libre)
const lights = [];
const instanced = []; // { kind, transforms:[[x,y,z,ry,scale]] }

let uid = 0;
const box = (mat, x, y, z, w, h, d, opts = {}) => {
  const o = {
    id: `s${uid++}`, kind: 'box', mat,
    pos: [r2(x), r2(y), r2(z)],
    size: [r2(w), r2(h), r2(d)],
    ry: opts.ry || 0,
    collide: opts.collide !== false,
    shadow: opts.shadow !== false,
  };
  if (opts.tile) o.tile = opts.tile;
  if (opts.detail) o.detail = opts.detail;
  (o.collide ? solids : decor).push(o);
  return o;
};
const r2 = (v) => Math.round(v * 100) / 100;

/* ---------------------------------------------------------------- sol */
const ground = { size: [W, D], mat: 'asphalt' };
const patches = [
  { pos: [-22, 0.02, -6], size: [26, 22], mat: 'concrete_slab', ry: 0 },
  { pos: [20, 0.02, 10], size: [30, 18], mat: 'concrete_slab', ry: 0 },
  { pos: [0, 0.02, 24], size: [18, 10], mat: 'concrete_slab', ry: 0 },
];

/* ------------------------------------------------------- mur d'enceinte */
const T = 1.1;
box('concrete', 0, WALL_H / 2, -D / 2 + T / 2, W, WALL_H, T);
box('concrete', 0, WALL_H / 2, D / 2 - T / 2, W, WALL_H, T);
box('concrete', -W / 2 + T / 2, WALL_H / 2, 0, T, WALL_H, D);
box('concrete', W / 2 - T / 2, WALL_H / 2, 0, T, WALL_H, D);

/* ------------------------------------------- entrepot ouest (briques) */
function warehouse(cx, cz, w, d, h, doors) {
  const t = 0.8;
  // mur nord / sud perces de portes
  for (const [sign, label] of [[-1, 'n'], [1, 's']]) {
    const z = cz + sign * (d / 2 - t / 2);
    const gap = doors[label];
    if (gap === null) { box('brick', cx, h / 2, z, w, h, t, { tile: [w / 2, h / 2] }); continue; }
    const [gs, gw] = gap;                       // centre local, largeur
    const leftW = (gs - gw / 2) + w / 2;
    const rightW = w / 2 - (gs + gw / 2);
    if (leftW > 0.2) box('brick', cx - w / 2 + leftW / 2, h / 2, z, leftW, h, t, { tile: [leftW / 2, h / 2] });
    if (rightW > 0.2) box('brick', cx + w / 2 - rightW / 2, h / 2, z, rightW, h, t, { tile: [rightW / 2, h / 2] });
    box('brick', cx + gs, h - 0.9, z, gw, 1.8, t, { tile: [gw / 2, 1] });   // linteau
  }
  // mur est / ouest
  for (const [sign, label] of [[-1, 'w'], [1, 'e']]) {
    const x = cx + sign * (w / 2 - t / 2);
    const gap = doors[label];
    if (gap === null) { box('brick', x, h / 2, cz, t, h, d, { tile: [d / 2, h / 2] }); continue; }
    const [gs, gw] = gap;
    const nearW = (gs - gw / 2) + d / 2;
    const farW = d / 2 - (gs + gw / 2);
    if (nearW > 0.2) box('brick', x, h / 2, cz - d / 2 + nearW / 2, t, h, nearW, { tile: [nearW / 2, h / 2] });
    if (farW > 0.2) box('brick', x, h / 2, cz + d / 2 - farW / 2, t, h, farW, { tile: [farW / 2, h / 2] });
    box('brick', x, h - 0.9, cz + gs, t, 1.8, gw, { tile: [gw / 2, 1] });
  }
  // toiture + verriere
  box('metal_roof', cx, h + 0.15, cz, w + 1.2, 0.3, d + 1.2, { collide: false, tile: [w / 2, d / 2] });
  decor.push({
    id: `s${uid++}`, kind: 'skylight', mat: 'glass',
    pos: [r2(cx), r2(h + 0.3), r2(cz)], size: [r2(w * 0.42), 0.12, r2(d * 0.78)], ry: 0,
    collide: false, shadow: false,
  });
  // poutres interieures
  const beams = Math.max(2, Math.round(w / 6));
  for (let i = 0; i < beams; i++) {
    const x = cx - w / 2 + (i + 0.5) * (w / beams);
    box('steel', x, h - 0.35, cz, 0.35, 0.7, d, { collide: false, shadow: false });
  }
  lights.push({ type: 'hall', pos: [cx, h - 0.8, cz], color: 0xffe2b0, intensity: 1.2, distance: Math.max(w, d) });
}

warehouse(-26, -8, 26, 26, 8.5, { n: [4, 6], s: [-3, 7], w: null, e: [2, 6] });
warehouse(28, 14, 24, 22, 7.5, { n: [0, 8], s: null, w: [-2, 6], e: null });

/* ------------------------------------- auvent central (cf. reference 3) */
(() => {
  const cx = 2, cz = 2, w = 22, d = 14, h = 6.2;
  box('metal_roof', cx, h, cz, w, 0.35, d, { collide: false, tile: [w / 2, d / 2] });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    box('steel', cx + sx * (w / 2 - 1), h / 2, cz + sz * (d / 2 - 1), 0.45, h, 0.45);
  }
  box('steel', cx, h - 0.4, cz, w, 0.3, 0.3, { collide: false, shadow: false });
  lights.push({ type: 'hall', pos: [cx, h - 0.6, cz], color: 0xfff0d0, intensity: 0.8, distance: 26 });
})();

/* ----------------------------------------------- conteneurs maritimes */
const CONT = [
  [-6, -22, 0, 'container_red'],
  [-6, -22, 1, 'container_blue'],      // empile
  [14, -20, 0, 'container_green'],
  [-34, 18, 0, 'container_blue'],
  [-30, 24, 0, 'container_red'],
  [34, -12, 0, 'container_green'],
  [10, 26, 0, 'container_red'],
  [-12, 14, 0, 'container_green'],
];
for (const [x, z, stack, mat] of CONT) {
  const h = 2.9, len = 12.2, wid = 2.6;
  const ry = (Math.abs(x) + Math.abs(z)) % 7 < 3 ? Math.PI / 2 : 0;
  const sz = ry === 0 ? [len, h, wid] : [wid, h, len];
  box(mat, x, h / 2 + stack * (h + 0.06), z, sz[0], sz[1], sz[2], { ry: 0, detail: 'container' });
}

/* --------------------------------------------- murets beton (jersey) */
const BARRIERS = [
  [-14, -2, 0], [-14, 2, 0], [-14, 6, 0],
  [6, -10, 1], [10, -10, 1], [14, -10, 1],
  [-2, 16, 0], [2, 16, 0],
  [24, -2, 1], [24, 2, 1],
  [-34, -24, 1], [-30, -24, 1],
  [30, 26, 0], [34, 26, 0],
];
for (const [x, z, rot] of BARRIERS) {
  const ry = rot ? Math.PI / 2 : 0;
  const s = rot ? [0.7, 1.05, 4] : [4, 1.05, 0.7];
  box('concrete_barrier', x, 0.525, z, s[0], s[1], s[2], { detail: 'jersey' });
}

/* ------------------------------------------- vehicules abandonnes */
const VEHICLES = [
  { kind: 'van', pos: [18, 0, -2], ry: Math.PI / 2, mat: 'van_white' },
  { kind: 'van', pos: [-18, 0, 26], ry: 0, mat: 'van_white' },
  { kind: 'truck', pos: [-40, 0, -26], ry: 0, mat: 'van_grey' },
];
for (const v of VEHICLES) {
  const len = v.kind === 'truck' ? 7.4 : 5.4;
  const hgt = v.kind === 'truck' ? 3.1 : 2.4;
  const wid = 2.25;
  const sz = Math.abs(v.ry) > 0.1 ? [wid, hgt, len] : [len, hgt, wid];
  solids.push({
    id: `s${uid++}`, kind: 'vehicle', sub: v.kind, mat: v.mat,
    pos: [v.pos[0], hgt / 2, v.pos[2]], size: sz, ry: v.ry, collide: true, shadow: true,
  });
}

/* ------------------------------------------------------- props instancies */
const rng = mulberry32(0xEA51);
const crates = [], barrels = [], pallets = [], debris = [];
const taken = (x, z, r) => solids.some(s =>
  Math.abs(x - s.pos[0]) < s.size[0] / 2 + r && Math.abs(z - s.pos[2]) < s.size[2] / 2 + r);
for (let i = 0; i < 46 && crates.length < 30; i++) {
  const x = (rng() - 0.5) * (W - 10), z = (rng() - 0.5) * (D - 10);
  if (taken(x, z, 1.2)) continue;
  crates.push([r2(x), 0.45, r2(z), r2(rng() * Math.PI * 2), r2(0.8 + rng() * 0.5)]);
}
for (let i = 0; i < 40 && barrels.length < 22; i++) {
  const x = (rng() - 0.5) * (W - 8), z = (rng() - 0.5) * (D - 8);
  if (taken(x, z, 1.0)) continue;
  barrels.push([r2(x), 0.58, r2(z), r2(rng() * Math.PI * 2), 1]);
}
for (let i = 0; i < 30 && pallets.length < 16; i++) {
  const x = (rng() - 0.5) * (W - 12), z = (rng() - 0.5) * (D - 12);
  if (taken(x, z, 1.4)) continue;
  pallets.push([r2(x), 0.07, r2(z), r2(rng() * Math.PI * 2), 1]);
}
for (let i = 0; i < 90; i++) {
  const x = (rng() - 0.5) * (W - 4), z = (rng() - 0.5) * (D - 4);
  debris.push([r2(x), 0.02, r2(z), r2(rng() * Math.PI * 2), r2(0.4 + rng() * 1.3)]);
}
instanced.push({ kind: 'crate', transforms: crates, collide: true, radius: 0.5 });
instanced.push({ kind: 'barrel', transforms: barrels, collide: true, radius: 0.42 });
instanced.push({ kind: 'pallet', transforms: pallets, collide: false });
instanced.push({ kind: 'debris', transforms: debris, collide: false });

/* ------------------------------------------- waypoints (pathfinding bots) */
const STEP = 4.5;
const nodes = [];
for (let x = -W / 2 + 4; x <= W / 2 - 4; x += STEP) {
  for (let z = -D / 2 + 4; z <= D / 2 - 4; z += STEP) {
    if (blocked(x, z, 0.75)) continue;
    nodes.push({ i: nodes.length, p: [r2(x), 0, r2(z)], n: [], cover: 0 });
  }
}
// aretes : voisins proches + trajet libre
for (let a = 0; a < nodes.length; a++) {
  for (let b = a + 1; b < nodes.length; b++) {
    const dx = nodes[a].p[0] - nodes[b].p[0], dz = nodes[a].p[2] - nodes[b].p[2];
    const dist = Math.hypot(dx, dz);
    if (dist > STEP * 1.5) continue;
    if (!clearPath(nodes[a].p, nodes[b].p, 0.7)) continue;
    nodes[a].n.push(nodes[b].i);
    nodes[b].n.push(nodes[a].i);
  }
}
// score de couverture : nombre de solides bas (<2.2m) a portee -> bon point d'embuscade
for (const nd of nodes) {
  let c = 0;
  for (const s of solids) {
    const top = s.pos[1] + s.size[1] / 2;
    if (top > 2.4 || top < 0.7) continue;
    const dx = Math.abs(nd.p[0] - s.pos[0]) - s.size[0] / 2;
    const dz = Math.abs(nd.p[2] - s.pos[2]) - s.size[2] / 2;
    if (Math.max(dx, 0) < 2.2 && Math.max(dz, 0) < 2.2) c++;
  }
  nd.cover = Math.min(3, c);
}

/* ------------- elagage : on ne garde que la plus grande composante connexe */
(function prune() {
  const seen = new Int32Array(nodes.length).fill(-1);
  let bestRoot = -1, bestSize = 0, comp = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (seen[i] >= 0) continue;
    const stack = [i]; seen[i] = comp; let size = 0;
    while (stack.length) {
      const k = stack.pop(); size++;
      for (const n of nodes[k].n) if (seen[n] < 0) { seen[n] = comp; stack.push(n); }
    }
    if (size > bestSize) { bestSize = size; bestRoot = comp; }
    comp++;
  }
  const kept = nodes.filter((_, i) => seen[i] === bestRoot);
  const remap = new Map(kept.map((nd, i) => [nd.i, i]));
  for (const nd of kept) {
    nd.n = nd.n.filter(n => remap.has(n)).map(n => remap.get(n));
    nd.i = remap.get(nd.i);
  }
  nodes.length = 0; nodes.push(...kept);
  console.log(`  elagage: ${bestSize} noeuds conserves sur ${seen.length} (${comp} composantes)`);
})();

/* ----------------------------------------------------------- spawns
 * Derives du graphe lui-meme : garantit que chaque spawn est navigable.
 * On prend les noeuds les plus eloignes de l'axe adverse, avec de la couverture. */
const spawns = (() => {
  const pick = (team) => {
    const sign = team === 0 ? -1 : 1;
    const home = [sign * (W / 2 - 8), 0, sign * (D / 2 - 8)];
    const scored = nodes
      .map(nd => ({
        nd,
        d: Math.hypot(nd.p[0] - home[0], nd.p[2] - home[2]),
      }))
      .filter(o => o.d < 26 && o.nd.n.length >= 2)
      .sort((a, b) => (a.d - a.nd.cover * 2.5) - (b.d - b.nd.cover * 2.5));
    const out = [];
    for (const o of scored) {
      if (out.length >= 8) break;
      if (out.every(p => Math.hypot(p[0] - o.nd.p[0], p[2] - o.nd.p[2]) > 3.6)) {
        out.push([o.nd.p[0], 0, o.nd.p[2]]);
      }
    }
    return out;
  };
  return { 0: pick(0), 1: pick(1) };
})();
if (spawns[0].length < 4 || spawns[1].length < 4) {
  throw new Error(`spawns insuffisants: A=${spawns[0].length} B=${spawns[1].length}`);
}

function blocked(x, z, pad) {
  for (const s of solids) {
    if (s.pos[1] - s.size[1] / 2 > 1.6) continue;       // on passe dessous
    if (Math.abs(x - s.pos[0]) < s.size[0] / 2 + pad && Math.abs(z - s.pos[2]) < s.size[2] / 2 + pad) return true;
  }
  for (const grp of instanced) {
    if (!grp.collide) continue;
    for (const t of grp.transforms) {
      if (Math.hypot(x - t[0], z - t[2]) < grp.radius + pad) return true;
    }
  }
  return false;
}
function clearPath(a, b, pad) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[2] - a[2]) / 0.6);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (blocked(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, pad)) return false;
  }
  return true;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const arena = {
  name: 'Foundry',
  bounds: { w: W, d: D, wallH: WALL_H },
  ground, patches,
  solids, decor, instanced, lights,
  spawns,
  waypoints: nodes,
  fog: { color: 0xbfc8d2, near: 34, far: 185, density: 0.0042 },
  sun: { dir: [-0.62, 0.30, 0.72], color: 0xfff1d8, intensity: 3.0, ambient: 0x6f7d8c, ambientIntensity: 0.9 },
};

mkdirSync(resolve(ROOT, 'shared'), { recursive: true });
writeFileSync(resolve(ROOT, 'shared/arena.json'), JSON.stringify(arena));
console.log(`arena -> solids=${solids.length} decor=${decor.length} waypoints=${nodes.length} edges=${nodes.reduce((a, n) => a + n.n.length, 0) / 2}`);
