/**
 * EasyRanked :: generation procedurale de textures PBR (aucun asset externe).
 *
 * Tout est peint sur des <canvas> puis derive en albedo / normal / roughness.
 * Les textures sont mises en cache par cle : une brique n'est calculee qu'une
 * fois, meme si 40 murs l'utilisent.
 */
import * as THREE from 'three';

const cache = new Map();
let anisotropy = 4;

export function setAnisotropy(v) { anisotropy = Math.max(1, v | 0); }

/* ------------------------------------------------------------------ bruit */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit de valeur lisse, tuilable (indispensable : les murs se repetent). */
function valueNoise(size, cells, seed) {
  const rnd = mulberry32(seed);
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rnd();
  const out = new Float32Array(size * size);
  const scale = cells / size;
  const smooth = (t) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    const fy = y * scale, y0 = Math.floor(fy), ty = smooth(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = x * scale, x0 = Math.floor(fx), tx = smooth(fx - x0);
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const a = grid[(y0 % cells) * cells + (x0 % cells)];
      const b = grid[(y0 % cells) * cells + x1];
      const c = grid[y1 * cells + (x0 % cells)];
      const d = grid[y1 * cells + x1];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}

/** Bruit fractal (fBm) : plusieurs octaves de bruit de valeur. */
function fbm(size, baseCells, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, cells = baseCells;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, cells, seed + o * 7919);
    for (let i = 0; i < out.length; i++) out[i] += layer[i] * amp;
    total += amp;
    amp *= gain;
    cells = Math.min(size, cells * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/* ------------------------------------------------------- outils de canvas */

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function toTexture(canvas, { repeat = [1, 1], srgb = false } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = anisotropy;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Derive une normal map depuis une carte de hauteur (operateur de Sobel). */
function heightToNormal(height, size, strength = 2.2) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
               - (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy = (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
               - (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
      let nx = dx * strength, ny = dy * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function grayCanvas(values, size, lo = 0, hi = 1) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < values.length; i++) {
    const v = Math.round(Math.max(0, Math.min(1, lo + values[i] * (hi - lo))) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const hexToRgb = (hex) => {
  const n = typeof hex === 'number' ? hex : parseInt(String(hex).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

/* ------------------------------------------------------------- materiaux */

/** Mur de briques : rangees decalees, joints en creux, usure. */
function brick(size = 512) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const rnd = mulberry32(0x8171);
  const rows = 16;
  const bh = size / rows;
  const bw = bh * 2.35;
  const mortar = [118, 112, 104];

  ctx.fillStyle = rgb(mortar);
  ctx.fillRect(0, 0, size, size);

  const height = new Float32Array(size * size).fill(0.25);
  const paint = (x, y, w, h, color) => {
    ctx.fillStyle = rgb(color);
    ctx.fillRect(x, y, w, h);
    const x0 = Math.max(0, Math.round(x)), x1 = Math.min(size, Math.round(x + w));
    const y0 = Math.max(0, Math.round(y)), y1 = Math.min(size, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) height[yy * size + xx] = 0.85;
  };

  for (let r = 0; r < rows; r++) {
    const offset = (r % 2) * (bw / 2);
    for (let x = -bw; x < size + bw; x += bw) {
      const v = rnd();
      const base = mix([142, 74, 56], [96, 52, 44], v);         // rouge brique variable
      const tint = mix(base, [120, 104, 92], rnd() * 0.22);      // quelques briques delavees
      paint(x + offset + 1.5, r * bh + 1.5, bw - 3, bh - 3, tint);
    }
  }

  // Salissures et coulures verticales.
  const grime = fbm(size, 8, 4, 0x3311);
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const g = grime[y * size + x];
      const streak = g * 0.55 + (y / size) * 0.25;
      const k = 1 - streak * 0.42;
      img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k;
      height[y * size + x] -= g * 0.12;
    }
  }
  ctx.putImageData(img, 0, 0);

  const rough = new Float32Array(size * size);
  for (let i = 0; i < rough.length; i++) rough[i] = 0.74 + height[i] * 0.16 + grime[i] * 0.08;
  return { map: canvas, height, rough, size };
}

/** Beton coule : taches, bulles, micro-fissures. */
function concrete(size = 512, tone = 0.0) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const blotch = fbm(size, 5, 5, 0x5a21);
  const grain = fbm(size, 64, 2, 0x991f);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const light = [162, 160, 156], dark = [96, 95, 93];

  for (let i = 0; i < size * size; i++) {
    const v = blotch[i] * 0.78 + grain[i] * 0.22;
    const c = mix(dark, light, Math.max(0, Math.min(1, v + tone)));
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
    height[i] = v * 0.5 + grain[i] * 0.5;
    rough[i] = 0.82 + (1 - v) * 0.14;
  }
  ctx.putImageData(img, 0, 0);

  // Fissures : marches aleatoires sombres.
  const rnd = mulberry32(0x7c3);
  ctx.strokeStyle = 'rgba(52,50,48,0.72)';
  for (let c = 0; c < 9; c++) {
    let x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2;
    ctx.lineWidth = 0.7 + rnd() * 1.3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 46; s++) {
      a += (rnd() - 0.5) * 0.9;
      x += Math.cos(a) * 6; y += Math.sin(a) * 6;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return { map: canvas, height, rough, size };
}

/** Enrobe bitumineux : gravillons, rapieçages, marquages uses. */
function asphalt(size = 512) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const grain = fbm(size, 96, 3, 0x2b7d);
  const patch = fbm(size, 4, 4, 0x4d19);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const g = grain[i], p = patch[i];
    const base = mix([44, 45, 48], [78, 79, 83], g * 0.8 + p * 0.3);
    img.data[i * 4] = base[0]; img.data[i * 4 + 1] = base[1]; img.data[i * 4 + 2] = base[2];
    img.data[i * 4 + 3] = 255;
    height[i] = g;
    rough[i] = 0.88 + g * 0.1;
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size };
}

/** Tole ondulee (toitures et bardages d'entrepot). */
function corrugated(size = 512, baseColor = 0x6a6f73) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rust = fbm(size, 7, 4, 0x1f55);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  const rustCol = [120, 68, 38];
  const period = size / 22;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const wave = 0.5 + 0.5 * Math.sin((x / period) * Math.PI * 2);
      const r = Math.max(0, rust[i] - 0.52) * 2.1;
      const c = mix(mix(base, [28, 30, 32], (1 - wave) * 0.4), rustCol, Math.min(1, r));
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = wave * 0.9 + rust[i] * 0.1;
      rough[i] = 0.46 + r * 0.42 + (1 - wave) * 0.08;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: 0.78 };
}

/**
 * Acier peint. `wear` dose l'ecaillage : eleve pour des poutres d'entrepot,
 * faible pour une carrosserie, qui doit lire comme de la tole peinte et non
 * comme du beton grele.
 */
function paintedSteel(size = 256, baseColor = 0x4a5157, wear = 1.0) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const scratch = fbm(size, 48, 3, 0x6611);
  const chip = fbm(size, 11, 4, 0x2aa1);
  const img = ctx.createImageData(size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  const threshold = 0.58 + (1 - wear) * 0.26;        // moins d'usure -> seuil plus haut
  for (let i = 0; i < size * size; i++) {
    const worn = Math.max(0, chip[i] - threshold) * 2.4 * wear;
    const c = mix(mix(base, [150, 148, 145], scratch[i] * 0.18 * wear),
                  [92, 84, 74], Math.min(1, worn));
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
    img.data[i * 4 + 3] = 255;
    height[i] = (scratch[i] * 0.4 + worn * 0.6) * wear;
    rough[i] = 0.3 + worn * 0.4 + scratch[i] * 0.1 * wear;
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: 0.88 };
}

/** Conteneur maritime : nervures verticales, peinture usee, rouille basse. */
function container(size = 512, baseColor = 0x8a3b32) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rust = fbm(size, 6, 5, 0x77c1);
  const grime = fbm(size, 20, 3, 0x1234);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  const period = size / 16;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Nervure trapezoidale, pas sinusoidale : plus proche du vrai profil.
      const ph = (x % period) / period;
      const rib = ph < 0.32 ? ph / 0.32 : ph < 0.68 ? 1 : (1 - ph) / 0.32;
      const lowRust = Math.pow(y / size, 2.3) * 0.75;
      const r = Math.min(1, Math.max(0, rust[i] - 0.5) * 2 + lowRust);
      let c = mix(base, [34, 36, 38], (1 - rib) * 0.3);
      c = mix(c, [112, 62, 34], r);
      c = mix(c, [60, 58, 56], grime[i] * 0.18);
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = rib * 0.85 + rust[i] * 0.15;
      rough[i] = 0.52 + r * 0.38;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: 0.7 };
}

/** Tissu technique (veste, pantalon) : trame serree + plis. */
function fabric(size = 256, baseColor = 0x2f3630) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const folds = fbm(size, 6, 4, 0x4411);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const weave = ((x & 3) < 2 ? 1 : 0) ^ ((y & 3) < 2 ? 1 : 0);
      const w = weave ? 1.06 : 0.94;
      const c = mix(base.map((v) => v * w), [20, 22, 20], folds[i] * 0.3);
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = weave * 0.35 + folds[i] * 0.65;
      rough[i] = 0.92 - folds[i] * 0.06;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size };
}

/** Cordura / kevlar du gilet : trame large et rigide. */
function cordura(size = 256, baseColor = 0x33382f) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const wear = fbm(size, 10, 3, 0x9a31);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  const cell = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const bx = Math.floor(x / cell) & 1, by = Math.floor(y / cell) & 1;
      const edge = (x % cell < 1 || y % cell < 1) ? 0.78 : 1;
      const w = (bx ^ by) ? 1.08 : 0.92;
      const c = mix(base.map((v) => v * w * edge), [120, 118, 112], wear[i] * 0.12);
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = (bx ^ by) * 0.5 + (1 - edge) * 0.5;
      rough[i] = 0.86 + wear[i] * 0.08;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size };
}

/** Polymere mat des armes (recepteur, poignees) + grip quadrille optionnel. */
function polymer(size = 256, baseColor = 0x23262a, grip = false) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const micro = fbm(size, 80, 2, 0x51a9);
  const wear = fbm(size, 9, 4, 0x3b7c);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let bump = micro[i] * 0.3;
      if (grip) {
        const g = Math.max(
          Math.abs(((x + y) % 16) / 16 - 0.5),
          Math.abs(((x - y + size) % 16) / 16 - 0.5)
        );
        bump += (1 - g * 2) * 0.7;
      }
      const edgeWear = Math.max(0, wear[i] - 0.68) * 2.6;
      const c = mix(base.map((v) => v * (0.9 + bump * 0.2)), [128, 126, 122], Math.min(0.5, edgeWear));
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = bump;
      rough[i] = 0.72 - edgeWear * 0.3 + micro[i] * 0.1;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: 0.08 };
}

/** Acier bronze / parkerise du canon et de la culasse. */
function gunmetal(size = 256) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const brush = fbm(size, 128, 2, 0x6d2a);
  const wear = fbm(size, 12, 4, 0x8e10);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const streak = brush[(y * size + ((x * 7) % size)) % (size * size)];
      const polish = Math.max(0, wear[i] - 0.66) * 2.8;
      const c = mix([38, 40, 43], [128, 132, 138], streak * 0.35 + polish * 0.5);
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
      height[i] = streak * 0.5;
      rough[i] = 0.44 - polish * 0.26 + streak * 0.06;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: 0.95 };
}

/** Peau (visage, nuque) : grain fin, legere variation sanguine. */
function skin(size = 128, baseColor = 0xb98a6a) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const pore = fbm(size, 64, 2, 0x4f2b);
  const blush = fbm(size, 5, 3, 0x1aa4);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const base = hexToRgb(baseColor);
  for (let i = 0; i < size * size; i++) {
    const c = mix(base, [148, 92, 76], blush[i] * 0.35);
    const k = 0.94 + pore[i] * 0.12;
    img.data[i * 4] = c[0] * k; img.data[i * 4 + 1] = c[1] * k; img.data[i * 4 + 2] = c[2] * k;
    img.data[i * 4 + 3] = 255;
    height[i] = pore[i];
    rough[i] = 0.62 + pore[i] * 0.12;
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size };
}

/** Camouflage procedural : utilise par le Gunsmith et les operateurs. */
function camouflage(size = 256, pattern = 'blotch', baseHex = '#4a5333', accentHex = '#2b3220', metal = false) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const base = hexToRgb(baseHex);
  const accent = hexToRgb(accentHex);
  const mid = mix(base, accent, 0.5);
  const dark = mix(accent, [12, 13, 14], 0.45);
  const rnd = mulberry32(0x5e11 + pattern.length * 131);

  ctx.fillStyle = rgb(base);
  ctx.fillRect(0, 0, size, size);

  const blob = (cx, cy, r, color, points = 10) => {
    ctx.fillStyle = rgb(color);
    ctx.beginPath();
    for (let i = 0; i <= points; i++) {
      const a = (i / points) * Math.PI * 2;
      const rr = r * (0.62 + rnd() * 0.6);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  };

  if (pattern === 'blotch') {
    for (const [col, count, rad] of [[accent, 22, size * 0.14], [mid, 16, size * 0.1], [dark, 12, size * 0.07]]) {
      for (let i = 0; i < count; i++) blob(rnd() * size, rnd() * size, rad, col);
    }
  } else if (pattern === 'splinter') {
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = rgb([accent, mid, dark][i % 3]);
      ctx.save();
      ctx.translate(rnd() * size, rnd() * size);
      ctx.rotate(rnd() * Math.PI);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(size * (0.05 + rnd() * 0.18), size * 0.02);
      ctx.lineTo(size * (0.02 + rnd() * 0.1), size * (0.05 + rnd() * 0.08));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  } else if (pattern === 'stripe') {
    for (let i = 0; i < 26; i++) {
      ctx.strokeStyle = rgb(i % 2 ? accent : dark);
      ctx.lineWidth = size * (0.012 + rnd() * 0.04);
      ctx.beginPath();
      let x = rnd() * size, y = -10;
      ctx.moveTo(x, y);
      while (y < size + 10) { x += (rnd() - 0.5) * 26; y += 16; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  } else if (pattern === 'digital') {
    const px = size / 32;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const v = rnd();
        if (v < 0.42) continue;
        ctx.fillStyle = rgb(v < 0.68 ? accent : v < 0.88 ? mid : dark);
        ctx.fillRect(x * px, y * px, px, px);
      }
    }
  }

  // Usure commune a tous les camos : la peinture s'ecaille sur les aretes.
  const wear = fbm(size, 13, 4, 0x9b31);
  const img = ctx.getImageData(0, 0, size, size);
  const height = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const w = Math.max(0, wear[i] - 0.70) * 3.0;
    const idx = i * 4;
    const worn = mix([img.data[idx], img.data[idx + 1], img.data[idx + 2]], [116, 114, 110], Math.min(0.75, w));
    img.data[idx] = worn[0]; img.data[idx + 1] = worn[1]; img.data[idx + 2] = worn[2];
    height[i] = wear[i] * 0.5;
    rough[i] = metal ? 0.3 + w * 0.2 : 0.78 - w * 0.3;
  }
  ctx.putImageData(img, 0, 0);
  return { map: canvas, height, rough, size, metal: metal ? 0.92 : 0.1 };
}

/* ------------------------------------------------------------- fabrique */

const RECIPES = {
  brick:              () => brick(512),
  concrete:           () => concrete(512, 0.0),
  concrete_barrier:   () => concrete(256, 0.08),
  concrete_slab:      () => concrete(512, -0.04),
  asphalt:            () => asphalt(512),
  metal_roof:         () => corrugated(512, 0x5f666b),
  steel:              () => paintedSteel(256, 0x454c52, 1.0),
  container_red:      () => container(512, 0x8a3b32),
  container_blue:     () => container(512, 0x2d4f6b),
  container_green:    () => container(512, 0x35543c),
  // Carrosseries : tole peinte, presque lisse, legerement sale.
  van_white:          () => paintedSteel(256, 0xbcbfbd, 0.28),
  van_grey:           () => paintedSteel(256, 0x74797d, 0.35),
  fabric:             () => fabric(256, 0x2f3630),
  fabric_pants:       () => fabric(256, 0x343a31),
  cordura:            () => cordura(256, 0x30342c),
  polymer:            () => polymer(256, 0x23262a, false),
  polymer_grip:       () => polymer(256, 0x1d2023, true),
  gunmetal:           () => gunmetal(256),
  skin:               () => skin(128, 0xb98a6a),
  rubber:             () => polymer(128, 0x15171a, false),
  crate_wood:         () => fabric(256, 0x6b5436),
  barrel:             () => paintedSteel(256, 0x4e5a3f, 0.7),
};

/**
 * Materiau PBR procedural.
 * @param {string} key    recette (cf. RECIPES) ou 'camo:<pattern>:<base>:<accent>'
 * @param {object} opts   { repeat, metalness, roughness, color, normalScale }
 */
export function material(key, opts = {}) {
  const repeat = opts.repeat || [1, 1];
  const cacheKey = `${key}|${repeat[0]}x${repeat[1]}|${JSON.stringify(opts.override || {})}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  let recipe;
  if (key.startsWith('camo:')) {
    const [, pattern, base, accent, metal] = key.split(':');
    recipe = camouflage(256, pattern, '#' + base, '#' + accent, metal === '1');
  } else {
    recipe = (RECIPES[key] || RECIPES.concrete)();
  }

  const mat = new THREE.MeshStandardMaterial({
    map: toTexture(recipe.map, { repeat, srgb: true }),
    normalMap: toTexture(heightToNormal(recipe.height, recipe.size, opts.normalStrength ?? 2.0), { repeat }),
    roughnessMap: toTexture(grayCanvas(recipe.rough, recipe.size), { repeat }),
    metalness: opts.metalness ?? recipe.metal ?? 0.0,
    roughness: 1.0,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1.0, opts.normalScale ?? 1.0),
    color: opts.color ?? 0xffffff,
    ...(opts.override || {}),
  });
  mat.name = key;
  cache.set(cacheKey, mat);
  return mat;
}

/** Variante du materiau d'un camo pour le Gunsmith. */
export function camoMaterial(camo, opts = {}) {
  if (!camo || camo.pattern === 'none') {
    return material('polymer', { ...opts, override: { color: new THREE.Color(camo?.base || '#2b2f33'),
      metalness: camo?.metal ? 0.9 : 0.12 } });
  }
  const key = `camo:${camo.pattern}:${camo.base.replace('#', '')}:${camo.accent.replace('#', '')}:${camo.metal ? 1 : 0}`;
  return material(key, opts);
}

/** Ciel degrade : nappe equirectangulaire peinte, utilisee comme environnement. */
export function skyTexture(size = 512) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.0, '#2d4f77');
  g.addColorStop(0.42, '#7fa3c4');
  g.addColorStop(0.56, '#cfd8dd');
  g.addColorStop(0.68, '#e8d2ad');
  g.addColorStop(1.0, '#8b8477');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // Nuages : bruit fractal etire horizontalement.
  const clouds = fbm(size, 6, 5, 0x2277);
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size * 0.56; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const band = 1 - y / (size * 0.56);
      const c = Math.max(0, clouds[y * size + x] - 0.46) * 2.2 * band;
      img.data[i] += (238 - img.data[i]) * c;
      img.data[i + 1] += (236 - img.data[i + 1]) * c;
      img.data[i + 2] += (230 - img.data[i + 2]) * c;
    }
  }
  ctx.putImageData(img, 0, 0);

  const t = new THREE.CanvasTexture(canvas);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Petite texture radiale (impacts, flashs, particules). */
export function sprite(kind = 'spark') {
  const key = 'sprite:' + kind;
  if (cache.has(key)) return cache.get(key);
  const size = 64;
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  if (kind === 'smoke') {
    g.addColorStop(0, 'rgba(190,190,190,0.55)');
    g.addColorStop(0.5, 'rgba(140,140,140,0.22)');
    g.addColorStop(1, 'rgba(120,120,120,0)');
  } else if (kind === 'hole') {
    g.addColorStop(0, 'rgba(10,10,10,0.95)');
    g.addColorStop(0.55, 'rgba(32,30,28,0.7)');
    g.addColorStop(1, 'rgba(60,58,56,0)');
  } else {
    g.addColorStop(0, 'rgba(255,238,190,1)');
    g.addColorStop(0.35, 'rgba(255,170,70,0.75)');
    g.addColorStop(1, 'rgba(255,120,30,0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  cache.set(key, t);
  return t;
}

export function disposeAll() {
  for (const m of cache.values()) {
    if (m.isMaterial) {
      for (const k of ['map', 'normalMap', 'roughnessMap']) m[k]?.dispose?.();
      m.dispose();
    } else m.dispose?.();
  }
  cache.clear();
}
