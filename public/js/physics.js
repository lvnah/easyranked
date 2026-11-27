/**
 * EasyRanked :: physique client.
 *
 * Le joueur est une capsule verticale resolue contre une liste d'AABB
 * (exactement celle du serveur). La resolution se fait axe par axe, ce qui
 * donne un glissement naturel le long des murs et evite les accrochages
 * typiques d'une resolution par vecteur unique.
 */
import * as THREE from 'three';

export const PLAYER = {
  radius: 0.34,
  height: 1.80,
  crouchHeight: 1.12,
  slideHeight: 1.02,
  eye: 1.62,
  stepHeight: 0.42,
};

const _min = new THREE.Vector3();
const _max = new THREE.Vector3();

export class Physics {
  /** @param {Array<{min:THREE.Vector3,max:THREE.Vector3,mat:string}>} colliders */
  constructor(colliders, bounds) {
    this.colliders = colliders;
    this.bounds = bounds;
    // Grille spatiale : un deplacement ne teste que les boites de sa cellule.
    this.cell = 8;
    this.grid = new Map();
    colliders.forEach((c, i) => {
      const x0 = Math.floor(c.min.x / this.cell), x1 = Math.floor(c.max.x / this.cell);
      const z0 = Math.floor(c.min.z / this.cell), z1 = Math.floor(c.max.z / this.cell);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x + ':' + z;
          let list = this.grid.get(k);
          if (!list) { list = []; this.grid.set(k, list); }
          list.push(i);
        }
      }
    });
    this._scratch = new Set();
  }

  /** Indices des boites potentiellement concernees par une AABB. */
  _candidates(min, max) {
    const out = this._scratch;
    out.clear();
    const x0 = Math.floor(min.x / this.cell), x1 = Math.floor(max.x / this.cell);
    const z0 = Math.floor(min.z / this.cell), z1 = Math.floor(max.z / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const list = this.grid.get(x + ':' + z);
        if (list) for (const i of list) out.add(i);
      }
    }
    return out;
  }

  /** AABB du joueur pour une position de pieds et une hauteur donnees. */
  static aabb(pos, height, radius = PLAYER.radius, out = { min: _min, max: _max }) {
    out.min.set(pos.x - radius, pos.y, pos.z - radius);
    out.max.set(pos.x + radius, pos.y + height, pos.z + radius);
    return out;
  }

  overlaps(pos, height, radius = PLAYER.radius) {
    const b = Physics.aabb(pos, height, radius);
    for (const i of this._candidates(b.min, b.max)) {
      const c = this.colliders[i];
      if (b.min.x < c.max.x && b.max.x > c.min.x &&
          b.min.y < c.max.y && b.max.y > c.min.y &&
          b.min.z < c.max.z && b.max.z > c.min.z) return c;
    }
    return null;
  }

  /**
   * Deplace le joueur en resolvant les collisions axe par axe.
   * @returns {{grounded:boolean, hitWall:boolean, ceiling:boolean}}
   */
  move(pos, delta, height, radius = PLAYER.radius) {
    const res = { grounded: false, hitWall: false, ceiling: false };

    // --- horizontal X, avec franchissement de marche
    if (delta.x !== 0) {
      const before = pos.x;
      pos.x += delta.x;
      if (this.overlaps(pos, height, radius)) {
        const stepped = pos.y + PLAYER.stepHeight;
        const probe = new THREE.Vector3(pos.x, stepped, pos.z);
        if (!this.overlaps(probe, height - PLAYER.stepHeight, radius) && delta.y <= 0.001) {
          pos.y = stepped;                 // on monte la marche
        } else {
          pos.x = before;
          res.hitWall = true;
        }
      }
    }

    // --- horizontal Z
    if (delta.z !== 0) {
      const before = pos.z;
      pos.z += delta.z;
      if (this.overlaps(pos, height, radius)) {
        const stepped = pos.y + PLAYER.stepHeight;
        const probe = new THREE.Vector3(pos.x, stepped, pos.z);
        if (!this.overlaps(probe, height - PLAYER.stepHeight, radius) && delta.y <= 0.001) {
          pos.y = stepped;
        } else {
          pos.z = before;
          res.hitWall = true;
        }
      }
    }

    // --- vertical
    if (delta.y !== 0) {
      pos.y += delta.y;
      const hit = this.overlaps(pos, height, radius);
      if (hit) {
        if (delta.y < 0) {
          pos.y = hit.max.y;               // on se pose sur le dessus
          res.grounded = true;
        } else {
          pos.y = hit.min.y - height;      // on cogne un plafond
          res.ceiling = true;
        }
      }
    }
    if (pos.y <= 0) { pos.y = 0; res.grounded = true; }

    // Limites de l'arene (double securite avec les murs d'enceinte).
    const hw = this.bounds.w / 2 - radius - 0.1;
    const hd = this.bounds.d / 2 - radius - 0.1;
    pos.x = Math.max(-hw, Math.min(hw, pos.x));
    pos.z = Math.max(-hd, Math.min(hd, pos.z));

    return res;
  }

  /** Teste si le joueur touche le sol (tolerance de 6 cm). */
  isGrounded(pos, height, radius = PLAYER.radius) {
    if (pos.y <= 0.001) return true;
    const probe = new THREE.Vector3(pos.x, pos.y - 0.06, pos.z);
    return this.overlaps(probe, height, radius) !== null;
  }

  /** Hauteur du sol sous une position (pour poser les bots / les grenades). */
  groundAt(x, z, fromY = 20) {
    const hit = this.raycast(new THREE.Vector3(x, fromY, z), new THREE.Vector3(0, -1, 0), fromY + 1);
    return hit ? hit.point.y : 0;
  }

  /**
   * Lancer de rayon contre le monde (methode des tranches sur AABB).
   * @returns {{dist:number, point:THREE.Vector3, normal:THREE.Vector3, mat:string}|null}
   */
  raycast(origin, dir, maxDist = 250) {
    const invX = safeInv(dir.x), invY = safeInv(dir.y), invZ = safeInv(dir.z);
    let best = maxDist;
    let bestC = null;
    let bestAxis = 0;
    let bestSign = 1;

    // On teste toutes les boites : ~100 AABB, c'est negligeable (<0.05 ms)
    // et cela evite de manquer une boite en traversant plusieurs cellules.
    for (let i = 0; i < this.colliders.length; i++) {
      const c = this.colliders[i];
      // Pour chaque axe, on entre par la face "min" si t(min) < t(max) ; la
      // normale de cette face est alors -axe, sinon +axe.
      let t1 = (c.min.x - origin.x) * invX;
      let t2 = (c.max.x - origin.x) * invX;
      let tmin = Math.min(t1, t2);
      let tmax = Math.max(t1, t2);
      let axis = 0;
      let sign = t1 < t2 ? -1 : 1;

      t1 = (c.min.y - origin.y) * invY; t2 = (c.max.y - origin.y) * invY;
      let lo = Math.min(t1, t2);
      if (lo > tmin) { tmin = lo; axis = 1; sign = t1 < t2 ? -1 : 1; }
      tmax = Math.min(tmax, Math.max(t1, t2));

      t1 = (c.min.z - origin.z) * invZ; t2 = (c.max.z - origin.z) * invZ;
      lo = Math.min(t1, t2);
      if (lo > tmin) { tmin = lo; axis = 2; sign = t1 < t2 ? -1 : 1; }
      tmax = Math.min(tmax, Math.max(t1, t2));

      if (tmax >= Math.max(tmin, 0) && tmin >= 0 && tmin < best) {
        best = tmin; bestC = c; bestAxis = axis; bestSign = sign;
      }
    }

    if (!bestC) return null;
    const point = origin.clone().addScaledVector(dir, best);
    const normal = new THREE.Vector3();
    normal.setComponent(bestAxis, bestSign);
    return { dist: best, point, normal, mat: bestC.mat };
  }

  lineOfSight(a, b) {
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-4) return true;
    dir.divideScalar(len);
    const hit = this.raycast(a, dir, len - 0.05);
    return hit === null;
  }
}

function safeInv(v) {
  if (v > 1e-12 || v < -1e-12) return 1 / v;
  return v >= 0 ? 1e12 : -1e12;
}

/* -------------------------------------------------- hitboxes des joueurs */

/**
 * Boites de degats d'un personnage (memes volumes que Ballistics::hitboxes
 * cote PHP : la prediction client et l'autorite serveur concordent).
 */
export function hitboxes(feet, stance = 1) {
  const s = Math.max(0.55, Math.min(1, stance));
  const y = (h) => feet.y + h * s;
  return [
    { zone: 'head', mul: 1.85, sphere: true, c: new THREE.Vector3(feet.x, y(1.655), feet.z), r: 0.155 },
    { zone: 'chest', mul: 1.0, c: new THREE.Vector3(feet.x, y(1.26), feet.z), he: new THREE.Vector3(0.26, 0.21 * s, 0.19) },
    { zone: 'stomach', mul: 1.0, c: new THREE.Vector3(feet.x, y(0.93), feet.z), he: new THREE.Vector3(0.23, 0.15 * s, 0.17) },
    { zone: 'arm_l', mul: 0.82, c: new THREE.Vector3(feet.x - 0.355, y(1.2), feet.z), he: new THREE.Vector3(0.1, 0.22 * s, 0.14) },
    { zone: 'arm_r', mul: 0.82, c: new THREE.Vector3(feet.x + 0.355, y(1.2), feet.z), he: new THREE.Vector3(0.1, 0.22 * s, 0.14) },
    { zone: 'legs', mul: 0.82, c: new THREE.Vector3(feet.x, y(0.42), feet.z), he: new THREE.Vector3(0.23, 0.42 * s, 0.18) },
  ];
}

/** Premier impact d'un rayon sur un personnage. */
export function rayPlayer(origin, dir, feet, stance, maxDist) {
  // Rejet rapide par sphere englobante.
  const cx = feet.x - origin.x, cy = (feet.y + 0.95 * stance) - origin.y, cz = feet.z - origin.z;
  const proj = cx * dir.x + cy * dir.y + cz * dir.z;
  if (proj < -1.2 || proj > maxDist + 1.2) return null;
  if ((cx * cx + cy * cy + cz * cz) - proj * proj > 1.35) return null;

  let best = null;
  for (const hb of hitboxes(feet, stance)) {
    const t = hb.sphere
      ? raySphere(origin, dir, hb.c, hb.r, maxDist)
      : rayBox(origin, dir, hb.c, hb.he, maxDist);
    if (t === null) continue;
    if (!best || t < best.dist - 1e-6 || (Math.abs(t - best.dist) <= 1e-6 && hb.mul > best.mul)) {
      best = { dist: t, zone: hb.zone, mul: hb.mul };
    }
  }
  return best;
}

function raySphere(o, d, c, r, maxDist) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  let t = -b - Math.sqrt(disc);
  if (t < 0) t = -b + Math.sqrt(disc);
  return (t >= 0 && t <= maxDist) ? t : null;
}

function rayBox(o, d, c, he, maxDist) {
  let tmin = -Infinity, tmax = Infinity;
  const oc = [o.x, o.y, o.z], dc = [d.x, d.y, d.z], cc = [c.x, c.y, c.z], hc = [he.x, he.y, he.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dc[i]) < 1e-9) {
      if (oc[i] < cc[i] - hc[i] || oc[i] > cc[i] + hc[i]) return null;
      continue;
    }
    const inv = 1 / dc[i];
    let t1 = (cc[i] - hc[i] - oc[i]) * inv;
    let t2 = (cc[i] + hc[i] - oc[i]) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  const t = tmin >= 0 ? tmin : tmax;
  return (t >= 0 && t <= maxDist) ? t : null;
}
