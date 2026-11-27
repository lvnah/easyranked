/**
 * EasyRanked :: modelisation 3D procedurale (aucun asset externe).
 *
 *  - buildDetailedArmoredCharacter() : operateur tactique complet, ~1.82 m,
 *    carrure robuste, gilet pare-balles volumineux, casque lourd + NVG double.
 *  - buildDetailedWeapon()           : arme 1ere personne (recepteur epais,
 *    chargeur courbe, rail Picatinny texture, poignee ergonomique).
 *  - buildAttachment()               : accessoires volumetriques greffes sur
 *    les sockets de l'arme (Gunsmith).
 *
 * Reperes : Y vers le haut, pieds a y=0 pour les personnages ;
 * pour les armes, -Z est la direction du canon, l'origine est la poignee.
 */
import * as THREE from 'three';
import { material, camoMaterial, sprite } from './textures.js';
import { box, cyl, sph, cap, cone, torus, piece, finalize, cloneShared } from './geo.js';

const TEAM_COLORS = [0x3d7fd1, 0xd16a3d];

/* =======================================================================
 *  OPERATEUR
 * ===================================================================== */

/**
 * Construit un operateur tactique.
 * @param {object} opts
 *   team      0|1          couleur des patches
 *   camo      objet camo   (shared/weapons.json -> camos[])
 *   firstPerson  bool      omet la tete (vue 1ere personne)
 * @returns {THREE.Group} racine avec userData.rig = { hips, spine, head, armL, ... }
 */
export function buildDetailedArmoredCharacter(opts = {}) {
  const team = opts.team ?? 0;
  const camo = opts.camo || null;

  const M = {
    jacket:  camo ? camoMaterial(camo, { repeat: [2, 3] }) : material('fabric', { repeat: [2, 3] }),
    pants:   camo ? camoMaterial(camo, { repeat: [2, 4] }) : material('fabric_pants', { repeat: [2, 4] }),
    vest:    material('cordura', { repeat: [2, 2] }),
    pouch:   material('cordura', { repeat: [1, 1] }),
    hard:    material('polymer', { repeat: [1, 1] }),
    rubber:  material('rubber', { repeat: [1, 1] }),
    metal:   material('gunmetal', { repeat: [1, 1] }),
    skin:    material('skin', { repeat: [1, 1] }),
    glass:   new THREE.MeshPhysicalMaterial({
      color: 0x14202a, metalness: 0.1, roughness: 0.08,
      transmission: 0.55, thickness: 0.01, ior: 1.42, transparent: true, opacity: 0.86,
    }),
    patch:   new THREE.MeshStandardMaterial({ color: TEAM_COLORS[team], roughness: 0.78, metalness: 0.0 }),
  };

  const root = new THREE.Group();
  root.name = 'operator';

  /* ------------------------------------------------------------- hanches */
  const hips = new THREE.Group();
  hips.name = 'rig:hips';
  hips.position.y = 0.95;          // plante les semelles exactement a y = 0
  root.add(hips);

  // Bassin : deux volumes croises pour casser l'effet "boite".
  piece(hips, box(0.36, 0.20, 0.26, 2), M.pants, { pos: [0, 0.0, 0] });
  piece(hips, cyl(0.175, 0.19, 0.22, 14), M.pants, { pos: [0, -0.04, 0], scale: [1, 1, 0.78] });
  // Ceinture tactique epaisse + boucle.
  piece(hips, cyl(0.195, 0.195, 0.075, 16), M.vest, { pos: [0, 0.055, 0], scale: [1, 1, 0.8] });
  piece(hips, box(0.085, 0.055, 0.035), M.metal, { pos: [0, 0.055, 0.155] });
  // Poches de hanche et dump pouch (volumes proeminents).
  for (const sx of [-1, 1]) {
    piece(hips, box(0.1, 0.17, 0.1, 1), M.pouch, { pos: [sx * 0.2, -0.02, 0.04] });
    piece(hips, box(0.085, 0.05, 0.09), M.pouch, { pos: [sx * 0.2, 0.07, 0.04] });
  }
  piece(hips, box(0.17, 0.15, 0.11), M.pouch, { pos: [0.1, -0.03, -0.17] });

  /* --------------------------------------------------------------- buste */
  const spine = new THREE.Group();
  spine.name = 'rig:spine';
  spine.position.y = 0.1;
  hips.add(spine);

  // Cage thoracique : boite centrale + flancs cylindriques + epaules arrondies.
  piece(spine, box(0.38, 0.42, 0.25, 2), M.jacket, { pos: [0, 0.2, 0] });
  for (const sx of [-1, 1]) {
    piece(spine, cyl(0.1, 0.115, 0.4, 12), M.jacket, { pos: [sx * 0.185, 0.19, 0], scale: [1, 1, 0.82] });
  }
  piece(spine, cyl(0.2, 0.185, 0.14, 16), M.jacket, { pos: [0, 0.38, 0], scale: [1, 1, 0.82] });
  // Capuche repliee dans la nuque (cf. reference : veste a capuche).
  piece(spine, sph(0.13, 12, 8), M.jacket, { pos: [0, 0.4, -0.13], scale: [1.15, 0.72, 0.85] });

  /* ------------------------------------------- gilet pare-balles (volume) */
  const vest = new THREE.Group();
  vest.name = 'rig:vest';
  spine.add(vest);
  // Plaques avant/arriere nettement en relief.
  piece(vest, box(0.34, 0.38, 0.075, 2), M.vest, { pos: [0, 0.21, 0.145] });
  piece(vest, box(0.34, 0.38, 0.07, 2), M.vest, { pos: [0, 0.21, -0.145] });
  // Cummerbund : ceinture laterale qui relie les deux plaques.
  for (const sx of [-1, 1]) {
    piece(vest, box(0.065, 0.22, 0.26), M.vest, { pos: [sx * 0.175, 0.13, 0] });
  }
  // Bretelles par-dessus les epaules.
  for (const sx of [-1, 1]) {
    piece(vest, box(0.085, 0.07, 0.3), M.vest, { pos: [sx * 0.115, 0.415, 0.0], rot: [0.12, 0, 0] });
    piece(vest, box(0.075, 0.055, 0.06), M.pouch, { pos: [sx * 0.115, 0.44, 0.1] });
  }
  // Trois porte-chargeurs frontaux, nettement saillants.
  for (let i = -1; i <= 1; i++) {
    const g = new THREE.Group();
    g.position.set(i * 0.105, 0.11, 0.21);
    vest.add(g);
    piece(g, box(0.095, 0.185, 0.085, 1), M.pouch, { pos: [0, 0, 0] });
    piece(g, box(0.1, 0.045, 0.09), M.pouch, { pos: [0, 0.095, 0.004] });   // rabat
    piece(g, box(0.055, 0.02, 0.012), M.hard, { pos: [0, 0.075, 0.05] });   // velcro
    piece(g, box(0.075, 0.055, 0.02), M.metal, { pos: [0, -0.07, 0.048] }); // chargeur qui depasse
  }
  // Poches utilitaires laterales + radio dans le dos.
  piece(vest, box(0.1, 0.13, 0.09), M.pouch, { pos: [0.2, 0.26, 0.09] });
  piece(vest, box(0.09, 0.15, 0.1), M.pouch, { pos: [-0.2, 0.24, 0.07] });
  piece(vest, box(0.1, 0.17, 0.08), M.pouch, { pos: [-0.09, 0.2, -0.2] });
  piece(vest, cyl(0.012, 0.012, 0.22, 6), M.rubber, { pos: [-0.09, 0.37, -0.2] });  // antenne
  // Patch d'equipe (identification visuelle immediate).
  piece(vest, box(0.085, 0.045, 0.012), M.patch, { pos: [0.11, 0.33, 0.185] });
  piece(vest, box(0.075, 0.04, 0.012), M.patch, { pos: [-0.1, 0.17, -0.19] });
  // Grenades accrochees (le HUD en bas a droite en montre le compte).
  for (const sx of [-1, 1]) {
    const gg = new THREE.Group();
    gg.position.set(sx * 0.17, 0.3, 0.14);
    vest.add(gg);
    piece(gg, cyl(0.032, 0.032, 0.085, 10), M.hard, { pos: [0, 0, 0] });
    piece(gg, cyl(0.014, 0.014, 0.03, 8), M.metal, { pos: [0, 0.055, 0] });
    piece(gg, torus(0.016, 0.004, 6, 10), M.metal, { pos: [0, 0.07, 0.012], rot: [Math.PI / 2, 0, 0] });
  }

  /* ---------------------------------------------------------------- tete */
  const head = new THREE.Group();
  head.name = 'rig:head';
  head.position.y = 0.52;
  spine.add(head);

  if (!opts.firstPerson) {
    // Cou epais (col de la veste par-dessus).
    piece(head, cyl(0.072, 0.082, 0.12, 12), M.skin, { pos: [0, -0.05, 0] });
    piece(head, cyl(0.095, 0.1, 0.07, 12), M.jacket, { pos: [0, -0.075, 0] });

    // Crane + machoire.
    piece(head, sph(0.105, 16, 12), M.skin, { pos: [0, 0.055, 0], scale: [1, 1.08, 1.1] });
    piece(head, box(0.14, 0.09, 0.14, 2), M.skin, { pos: [0, -0.005, 0.012] });

    // Masque / cache-cou remontant sur le nez (cf. reference).
    piece(head, box(0.145, 0.11, 0.145, 2), M.jacket, { pos: [0, -0.015, 0.015], scale: [1.02, 1, 1.02] });
    piece(head, cyl(0.082, 0.072, 0.07, 12), M.jacket, { pos: [0, 0.028, 0.045], rot: [0.25, 0, 0] });

    /* ----------------------------------------------- casque lourd arrondi */
    const helmet = new THREE.Group();
    helmet.position.set(0, 0.075, 0);
    head.add(helmet);
    // Coque : demi-sphere epaisse + couronne, pas une simple sphere.
    piece(helmet, sph(0.128, 18, 14), M.hard, { pos: [0, 0.01, -0.004], scale: [1.04, 0.96, 1.1] });
    piece(helmet, cyl(0.132, 0.126, 0.07, 18), M.hard, { pos: [0, -0.035, -0.004], scale: [1.02, 1, 1.08] });
    // Couvre-oreilles (casque de communication) : gros volumes lateraux.
    for (const sx of [-1, 1]) {
      piece(helmet, cyl(0.055, 0.05, 0.045, 12), M.hard,
        { pos: [sx * 0.118, -0.045, -0.01], rot: [0, 0, Math.PI / 2] });
      piece(helmet, cyl(0.042, 0.042, 0.016, 10), M.rubber,
        { pos: [sx * 0.142, -0.045, -0.01], rot: [0, 0, Math.PI / 2] });
    }
    // Micro-perche.
    piece(helmet, cyl(0.007, 0.007, 0.12, 6), M.rubber,
      { pos: [0.1, -0.075, 0.055], rot: [0.5, 0, 0.6] });
    piece(helmet, sph(0.016, 8, 6), M.rubber, { pos: [0.055, -0.1, 0.105] });
    // Rails lateraux et velcro superieur.
    for (const sx of [-1, 1]) {
      piece(helmet, box(0.012, 0.022, 0.16), M.hard, { pos: [sx * 0.128, 0.0, -0.005] });
    }
    piece(helmet, box(0.09, 0.008, 0.12), M.vest, { pos: [0, 0.12, -0.01] });

    // Patch d'equipe sur le cote du casque.
    piece(helmet, box(0.03, 0.022, 0.006), M.patch, { pos: [-0.126, 0.03, 0.06] });

    /* ------------------------------- module de vision nocturne (NVG double) */
    const nvg = new THREE.Group();
    nvg.position.set(0, 0.085, 0.105);
    helmet.add(nvg);
    // Platine de fixation sur le front.
    piece(nvg, box(0.07, 0.045, 0.035), M.hard, { pos: [0, -0.01, -0.02] });
    piece(nvg, box(0.045, 0.03, 0.05), M.hard, { pos: [0, 0.0, 0.015] });
    // Bras articule releve.
    piece(nvg, box(0.028, 0.07, 0.022), M.hard, { pos: [0, 0.03, 0.035], rot: [-0.35, 0, 0] });
    // Les deux tubes, avec objectifs et pare-soleil.
    for (const sx of [-1, 1]) {
      const tube = new THREE.Group();
      tube.position.set(sx * 0.034, 0.055, 0.055);
      tube.rotation.x = -0.28;
      nvg.add(tube);
      piece(tube, cyl(0.026, 0.026, 0.1, 12), M.hard, { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] });
      piece(tube, cyl(0.029, 0.026, 0.022, 12), M.hard, { pos: [0, 0, 0.058], rot: [Math.PI / 2, 0, 0] });
      piece(tube, cyl(0.021, 0.021, 0.006, 12), M.glass, { pos: [0, 0, 0.07], rot: [Math.PI / 2, 0, 0] });
      piece(tube, box(0.012, 0.012, 0.03), M.hard, { pos: [sx * 0.026, 0.012, -0.02] });
    }

    /* -------------------------------------------------- visiere / lunettes */
    const visor = new THREE.Group();
    visor.position.set(0, 0.045, 0.072);
    head.add(visor);
    piece(visor, box(0.2, 0.055, 0.045, 2), M.hard, { pos: [0, 0, -0.01], scale: [1, 1, 1] });
    piece(visor, cyl(0.1, 0.1, 0.055, 16, true), M.glass,
      { pos: [0, 0, -0.015], rot: [Math.PI / 2, 0, 0], scale: [1, 1, 0.52] });
    piece(visor, box(0.215, 0.018, 0.018), M.rubber, { pos: [0, 0.032, -0.012] });
    for (const sx of [-1, 1]) {
      piece(visor, box(0.02, 0.02, 0.09), M.rubber, { pos: [sx * 0.098, 0.01, -0.06] });
    }
  }

  /* ---------------------------------------------------------------- bras */
  const arms = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const shoulder = new THREE.Group();
    shoulder.name = `rig:arm${side}.shoulder`;
    shoulder.position.set(sx * 0.225, 0.4, 0);
    spine.add(shoulder);

    // Deltoide : sphere volumineuse + protection d'epaule du gilet.
    piece(shoulder, sph(0.105, 14, 10), M.jacket, { pos: [0, 0, 0], scale: [1, 1.05, 1] });
    piece(shoulder, cyl(0.1, 0.095, 0.1, 12), M.vest, { pos: [sx * 0.022, 0.015, 0], rot: [0, 0, sx * 0.3] });

    // Bras : manche ample (capsule epaisse) + renfort de coude.
    const upper = new THREE.Group();
    upper.name = `rig:arm${side}.upper`;
    upper.position.set(0, -0.03, 0);
    shoulder.add(upper);
    piece(upper, cap(0.078, 0.2, 10, 6), M.jacket, { pos: [0, -0.12, 0] });
    piece(upper, cyl(0.082, 0.072, 0.07, 12), M.jacket, { pos: [0, -0.21, 0] });
    // Brassard (patch d'equipe visible de loin).
    piece(upper, cyl(0.084, 0.084, 0.05, 12), M.patch, { pos: [0, -0.07, 0] });

    const fore = new THREE.Group();
    fore.name = `rig:arm${side}.fore`;
    fore.position.set(0, -0.245, 0);
    upper.add(fore);
    piece(fore, cap(0.066, 0.16, 10, 6), M.jacket, { pos: [0, -0.095, 0] });
    piece(fore, sph(0.072, 12, 8), M.hard, { pos: [0, 0.0, 0], scale: [1, 0.8, 1] });   // coudiere
    piece(fore, cyl(0.07, 0.062, 0.045, 12), M.vest, { pos: [0, -0.175, 0] });          // poignet

    // Gant epais : paume + dos renforce + doigts groupes.
    const hand = new THREE.Group();
    hand.name = `rig:arm${side}.hand`;
    hand.position.set(0, -0.2, 0);
    fore.add(hand);
    arms[side] = { shoulder, upper, fore, hand };
    piece(hand, box(0.085, 0.1, 0.055, 1), M.rubber, { pos: [0, -0.04, 0.0] });
    piece(hand, box(0.09, 0.055, 0.062), M.hard, { pos: [0, -0.015, 0.0] });
    piece(hand, box(0.082, 0.06, 0.05), M.rubber, { pos: [0, -0.095, 0.008] });
    piece(hand, box(0.03, 0.055, 0.045), M.rubber, { pos: [sx * 0.05, -0.045, 0.012], rot: [0, 0, sx * -0.4] });
  }

  /* -------------------------------------------------------------- jambes */
  const legs = {};
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const hip = new THREE.Group();
    hip.name = `rig:leg${side}.hip`;
    hip.position.set(sx * 0.105, -0.06, 0);
    hips.add(hip);

    // Cuisse large : capsule + sur-cylindre pour l'ampleur du pantalon.
    const thigh = new THREE.Group();
    thigh.name = `rig:leg${side}.thigh`;
    hip.add(thigh);
    piece(thigh, cap(0.105, 0.28, 10, 6), M.pants, { pos: [0, -0.21, 0] });
    piece(thigh, cyl(0.115, 0.1, 0.2, 12), M.pants, { pos: [0, -0.12, 0] });
    // Poche cargo laterale (volume saillant).
    piece(thigh, box(0.075, 0.18, 0.12), M.pouch, { pos: [sx * 0.105, -0.22, 0.01] });
    piece(thigh, box(0.08, 0.04, 0.125), M.pouch, { pos: [sx * 0.105, -0.125, 0.012] });

    const shin = new THREE.Group();
    shin.name = `rig:leg${side}.shin`;
    shin.position.set(0, -0.46, 0);
    thigh.add(shin);
    piece(shin, cap(0.085, 0.26, 10, 6), M.pants, { pos: [0, -0.155, 0] });
    piece(shin, cyl(0.095, 0.082, 0.11, 12), M.pants, { pos: [0, -0.06, 0] });
    // Genouillere epaisse en relief : coque + rembourrage + sangles.
    const knee = new THREE.Group();
    knee.position.set(0, 0.015, 0.075);
    shin.add(knee);
    piece(knee, sph(0.082, 14, 10), M.hard, { pos: [0, 0, 0], scale: [1.05, 1.15, 0.72] });
    piece(knee, cyl(0.07, 0.078, 0.055, 14), M.hard, { pos: [0, -0.055, -0.012], scale: [1, 1, 0.78] });
    piece(knee, box(0.14, 0.03, 0.055), M.vest, { pos: [0, 0.045, -0.03] });
    piece(knee, box(0.15, 0.028, 0.05), M.vest, { pos: [0, -0.075, -0.035] });
    // Bas de pantalon resserre dans la botte.
    piece(shin, cyl(0.092, 0.098, 0.09, 12), M.pants, { pos: [0, -0.275, 0] });

    // Botte de combat : semelle crantee, tige haute, lacets.
    const foot = new THREE.Group();
    foot.name = `rig:leg${side}.foot`;
    foot.position.set(0, -0.333, 0);
    shin.add(foot);
    legs[side] = { hip, thigh, shin, foot };
    piece(foot, box(0.115, 0.1, 0.17, 1), M.rubber, { pos: [0, -0.01, 0.01] });        // tige basse
    piece(foot, box(0.12, 0.055, 0.28, 1), M.rubber, { pos: [0, -0.055, 0.045] });     // pied
    piece(foot, box(0.125, 0.03, 0.285), M.rubber, { pos: [0, -0.082, 0.045] });       // semelle
    piece(foot, box(0.1, 0.045, 0.07), M.rubber, { pos: [0, -0.045, 0.165] });         // bout renforce
    for (let i = 0; i < 5; i++) {
      piece(foot, box(0.085, 0.008, 0.012), M.hard, { pos: [0, 0.02 - i * 0.022, 0.085] });  // lacets
    }
  }

  // Fusion : on passe de ~130 primitives a une poignee de meshes par articulation.
  finalize(root);

  root.userData.rig = {
    hips, spine, head, vest,
    armL: arms.L, armR: arms.R,
    legL: legs.L, legR: legs.R,
  };
  root.userData.isOperator = true;
  return root;
}

/* =======================================================================
 *  ARMES
 * ===================================================================== */

/** Barre Picatinny : base + dents regulieres (vraies encoches, pas une texture). */
function picatinny(parent, mat, { length, width = 0.021, y = 0, z = 0, teeth = 0.0115 }) {
  piece(parent, box(width, 0.009, length), mat, { pos: [0, y, z] });
  const n = Math.max(3, Math.floor(length / (teeth * 2)));
  for (let i = 0; i < n; i++) {
    const zz = z - length / 2 + teeth + i * (length / n);
    piece(parent, box(width * 1.06, 0.0075, teeth * 0.95), mat, { pos: [0, y + 0.008, zz] });
  }
}

/** Fentes M-LOK sur un garde-main (creuse visuellement les flancs). */
function mlok(parent, mat, { length, radius, z, rows = 3 }) {
  for (const sx of [-1, 1]) {
    for (let i = 0; i < rows; i++) {
      const zz = z - length / 2 + length * (0.22 + i * 0.28);
      piece(parent, box(0.004, 0.012, length * 0.17), mat, { pos: [sx * radius, 0, zz] });
    }
  }
  piece(parent, box(0.012, 0.004, length * 0.6), mat, { pos: [0, -radius, z] });
}

/**
 * Construit une arme complete.
 * @param {object} opts
 *   shape  'carbine' | 'smg' | 'ak' | 'dmr'
 *   camo   objet camo pour le recepteur / garde-main
 *   attachments { optic, barrel, muzzle, stock, laser, grip, mag }
 * @returns {THREE.Group} userData.sockets = { optic, muzzle, barrel, stock, laser, grip, mag, muzzleTip, ejectPort }
 */
export function buildDetailedWeapon(opts = {}) {
  const shape = opts.shape || 'carbine';
  const camo = opts.camo || null;

  const M = {
    body:   camo ? camoMaterial(camo, { repeat: [2, 2] }) : material('polymer', { repeat: [2, 2] }),
    grip:   material('polymer_grip', { repeat: [2, 2] }),
    metal:  material('gunmetal', { repeat: [2, 2] }),
    rubber: material('rubber', { repeat: [1, 1] }),
    wood:   material('crate_wood', { repeat: [1, 2] }),
  };

  const root = new THREE.Group();
  root.name = 'weapon:' + shape;

  const P = {
    carbine: { recL: 0.30, recH: 0.082, recW: 0.062, hgL: 0.26, barrel: 0.26, barrelR: 0.0115,
               magCurve: 0.06, magLen: 0.19, stock: 0.21, rail: 0.5 },
    smg:     { recL: 0.26, recH: 0.086, recW: 0.058, hgL: 0.17, barrel: 0.14, barrelR: 0.0115,
               magCurve: 0.09, magLen: 0.21, stock: 0.16, rail: 0.36 },
    ak:      { recL: 0.32, recH: 0.092, recW: 0.066, hgL: 0.23, barrel: 0.3, barrelR: 0.0125,
               magCurve: 0.22, magLen: 0.23, stock: 0.23, rail: 0.44 },
    dmr:     { recL: 0.36, recH: 0.086, recW: 0.062, hgL: 0.33, barrel: 0.38, barrelR: 0.011,
               magCurve: 0.05, magLen: 0.17, stock: 0.25, rail: 0.62 },
  }[shape];

  // Repere : le recepteur est centre autour de z = -0.09, le canon part vers -Z.
  const recZ = -0.09;
  const recFront = recZ - P.recL / 2;
  const recBack = recZ + P.recL / 2;

  /* ------------------------------------------------------ boitier de culasse */
  const body = new THREE.Group();
  root.add(body);
  // Bloc principal epais + dessous arrondi (pas une plaque fine).
  piece(body, box(P.recW, P.recH, P.recL, 2), M.body, { pos: [0, 0, recZ] });
  piece(body, cyl(P.recW * 0.42, P.recW * 0.42, P.recL * 0.96, 14), M.body,
    { pos: [0, -P.recH * 0.32, recZ], rot: [Math.PI / 2, 0, 0] });
  // Capot superieur et renforts.
  piece(body, box(P.recW * 0.92, 0.016, P.recL * 0.9), M.metal, { pos: [0, P.recH / 2 + 0.004, recZ] });
  piece(body, box(P.recW * 1.04, 0.03, 0.03), M.body, { pos: [0, 0.012, recBack - 0.03] });

  // Fenetre d'ejection en creux + douille.
  piece(body, box(0.006, 0.03, 0.07), M.metal, { pos: [P.recW / 2, 0.012, recZ - 0.05] });
  piece(body, box(0.005, 0.022, 0.058), M.rubber, { pos: [P.recW / 2 + 0.003, 0.012, recZ - 0.05] });
  // Levier d'armement.
  if (shape === 'ak') {
    piece(body, box(0.02, 0.016, 0.055), M.metal, { pos: [P.recW / 2 + 0.008, 0.026, recZ + 0.02] });
  } else {
    piece(body, box(0.05, 0.014, 0.016), M.metal, { pos: [0, P.recH / 2 + 0.014, recBack - 0.012] });
    piece(body, box(0.016, 0.012, 0.05), M.metal, { pos: [-0.025, P.recH / 2 + 0.014, recBack - 0.04] });
  }
  // Selecteur de tir et bouton de chargeur.
  piece(body, cyl(0.011, 0.011, 0.008, 8), M.metal,
    { pos: [-P.recW / 2 - 0.004, -0.012, recBack - 0.055], rot: [0, 0, Math.PI / 2] });
  piece(body, box(0.016, 0.022, 0.006), M.metal, { pos: [-P.recW / 2 - 0.008, -0.012, recBack - 0.055] });
  piece(body, cyl(0.008, 0.008, 0.012, 8), M.metal,
    { pos: [P.recW / 2 + 0.003, -0.022, recFront + 0.03], rot: [0, 0, Math.PI / 2] });

  /* ----------------------------------------------------- rail Picatinny */
  const railLen = P.recL * 0.74;
  picatinny(body, M.metal, { length: railLen, y: P.recH / 2 + 0.017, z: recZ - 0.01, width: 0.022 });

  /* -------------------------------------------------------- garde-main */
  const hg = new THREE.Group();
  hg.position.set(0, -0.002, recFront - P.hgL / 2);
  body.add(hg);
  const hgR = P.recW * 0.44;
  if (shape === 'ak') {
    // AK : garde-main en deux parties avec events, plus epais.
    piece(hg, box(P.recW * 0.98, 0.055, P.hgL, 2), M.body, { pos: [0, -0.012, 0] });
    piece(hg, cyl(hgR, hgR, P.hgL, 14), M.body, { pos: [0, -0.022, 0], rot: [Math.PI / 2, 0, 0] });
    piece(hg, box(P.recW * 0.8, 0.03, P.hgL * 0.5), M.metal, { pos: [0, 0.03, -P.hgL * 0.1] });
    for (let i = 0; i < 4; i++) {
      piece(hg, box(P.recW * 0.84, 0.006, 0.012), M.metal, { pos: [0, 0.045, -P.hgL * 0.3 + i * 0.03] });
    }
  } else {
    // Tube free-float a section octogonale (8 facettes = volume credible).
    piece(hg, cyl(hgR * 1.02, hgR * 1.02, P.hgL, 8), M.body, { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] });
    mlok(hg, M.metal, { length: P.hgL, radius: hgR, z: 0 });
  }
  // Rail superieur du garde-main, aligne avec celui du recepteur.
  picatinny(hg, M.metal, { length: P.hgL * 0.92, y: hgR + 0.012, z: 0, width: 0.022 });
  // Ecrou de barillet.
  piece(hg, cyl(hgR * 1.1, hgR * 1.1, 0.022, 12), M.metal, { pos: [0, 0, P.hgL / 2 - 0.005], rot: [Math.PI / 2, 0, 0] });

  /* -------------------------------------------------------------- canon */
  const barrelZ = recFront - P.hgL;
  const exposed = Math.max(0.03, P.barrel - P.hgL);
  piece(body, cyl(P.barrelR, P.barrelR, P.barrel, 12), M.metal,
    { pos: [0, -0.002, recFront - P.barrel / 2], rot: [Math.PI / 2, 0, 0] });
  // Portion visible, cannelee.
  if (exposed > 0.04) {
    piece(body, cyl(P.barrelR * 1.25, P.barrelR * 1.25, 0.018, 12), M.metal,
      { pos: [0, -0.002, barrelZ + 0.012], rot: [Math.PI / 2, 0, 0] });
    piece(body, cyl(P.barrelR * 0.92, P.barrelR * 0.92, exposed, 12), M.metal,
      { pos: [0, -0.002, barrelZ - exposed / 2], rot: [Math.PI / 2, 0, 0] });
  }
  const muzzleZ = recFront - P.barrel;
  // Bloc de gaz (AK/carabine) ou bloc de guidon.
  if (shape !== 'dmr') {
    piece(body, box(0.03, 0.045, 0.045), M.metal, { pos: [0, 0.012, barrelZ + 0.03] });
  }
  /* --------------------------------- mires metalliques (sans optique) */
  // Guidon et oeilleton sont places exactement a la hauteur de visee par
  // defaut : sans optique, la pose d'ADS les aligne pile sur le reticule.
  const sightY = P.recH / 2 + 0.047;
  // Guidon : tourelle + ergot, protege par deux oreilles.
  piece(body, box(0.022, 0.03, 0.018), M.metal, { pos: [0, sightY - 0.018, barrelZ + 0.03] });
  piece(body, box(0.006, 0.026, 0.01), M.metal, { pos: [0, sightY, barrelZ + 0.03] });
  for (const sx of [-1, 1]) {
    piece(body, box(0.005, 0.03, 0.01), M.metal, { pos: [sx * 0.013, sightY - 0.004, barrelZ + 0.03] });
  }
  // Oeilleton : anneau a l'arriere du rail du recepteur.
  const apertureZ = recZ - 0.01 + railLen / 2 - 0.018;
  piece(body, box(0.03, 0.016, 0.016), M.metal, { pos: [0, sightY - 0.026, apertureZ] });
  piece(body, torus(0.0105, 0.0035, 6, 14), M.metal,
    { pos: [0, sightY, apertureZ], rot: [0, 0, 0] });
  piece(body, box(0.034, 0.008, 0.012), M.metal, { pos: [0, sightY - 0.012, apertureZ] });

  /* ------------------------------------------------------------ chargeur */
  const magWellZ = recZ + 0.02;
  const mag = new THREE.Group();
  mag.position.set(0, -P.recH / 2 - 0.01, magWellZ);
  body.add(mag);
  buildMagazine(mag, M, P, shape, 1.0);

  /* -------------------------------------------- poignee pistolet + detente */
  const gripZ = recBack - 0.065;
  const grip = new THREE.Group();
  grip.position.set(0, -P.recH / 2, gripZ);
  grip.rotation.x = -0.34;                       // inclinaison ergonomique
  body.add(grip);
  piece(grip, box(0.044, 0.125, 0.052, 2), M.grip, { pos: [0, -0.07, 0] });
  piece(grip, cyl(0.026, 0.023, 0.12, 12), M.grip, { pos: [0, -0.07, 0.002], scale: [1, 1, 0.86] });
  piece(grip, box(0.05, 0.03, 0.058), M.grip, { pos: [0, -0.135, 0.004] });     // talon
  piece(grip, box(0.046, 0.05, 0.018), M.grip, { pos: [0, -0.03, 0.03] });      // repose-pouce
  // Pontet et detente.
  piece(body, torus(0.028, 0.007, 6, 14), M.body,
    { pos: [0, -P.recH / 2 - 0.028, gripZ - 0.028], rot: [0, Math.PI / 2, 0], scale: [1, 1.1, 1] });
  piece(body, box(0.01, 0.028, 0.009), M.metal, { pos: [0, -P.recH / 2 - 0.022, gripZ - 0.026] });

  /* --------------------------------------------------------------- crosse */
  const stock = new THREE.Group();
  stock.position.set(0, 0.0, recBack);
  body.add(stock);
  buildStock(stock, M, P, shape, 'default');

  /* --------------------------------------------------------------- sockets */
  const sockets = {
    optic:   new THREE.Object3D(),
    muzzle:  new THREE.Object3D(),
    barrel:  new THREE.Object3D(),
    stock:   new THREE.Object3D(),
    laser:   new THREE.Object3D(),
    grip:    new THREE.Object3D(),
    mag:     new THREE.Object3D(),
    muzzleTip: new THREE.Object3D(),
    ejectPort: new THREE.Object3D(),
    sightLine: new THREE.Object3D(),
  };
  sockets.optic.position.set(0, P.recH / 2 + 0.026, recZ - 0.02);
  sockets.muzzle.position.set(0, -0.002, muzzleZ);
  sockets.barrel.position.set(0, -0.002, barrelZ);
  sockets.stock.position.set(0, 0, recBack);
  sockets.laser.position.set(-hgR - 0.008, 0.0, recFront - P.hgL * 0.55);
  sockets.grip.position.set(0, -hgR - 0.012, recFront - P.hgL * 0.62);
  sockets.mag.position.set(0, -P.recH / 2 - 0.01, magWellZ);
  sockets.muzzleTip.position.set(0, -0.002, muzzleZ - 0.01);
  sockets.ejectPort.position.set(P.recW / 2 + 0.02, 0.014, recZ - 0.05);
  sockets.sightLine.position.set(0, P.recH / 2 + 0.047, recZ);
  for (const [name, s] of Object.entries(sockets)) {
    s.name = 'socket:' + name;      // les clones retrouvent les sockets par nom
    root.add(s);
  }
  body.name = 'weapon:body';
  mag.name = 'weapon:mag';
  stock.name = 'weapon:stock';

  finalize(body);
  root.userData.sockets = sockets;
  root.userData.params = P;
  root.userData.shape = shape;
  root.userData.materials = M;
  root.userData.magGroup = mag;
  root.userData.stockGroup = stock;
  root.userData.attached = {};

  // Accessoires demandes a la construction.
  if (opts.attachments) applyAttachments(root, opts.attachments, camo);
  return root;
}

/** Chargeur courbe : plusieurs segments inclines (vraie banane, pas une plaque). */
function buildMagazine(parent, M, P, shape, lengthMul = 1.0) {
  const segs = shape === 'ak' ? 5 : 4;
  const len = P.magLen * lengthMul;
  const segLen = len / segs;
  const curve = P.magCurve;
  let y = -segLen / 2, z = 0, angle = 0;
  for (let i = 0; i < segs; i++) {
    angle += curve / segs;
    const w = 0.03 + i * 0.0015;
    piece(parent, box(w, segLen * 1.08, 0.052 + i * 0.0012, 1), M.body,
      { pos: [0, y, z], rot: [angle, 0, 0] });
    // Nervures de rigidite visibles sur les flancs.
    piece(parent, box(w + 0.004, segLen * 0.3, 0.056 + i * 0.0012), M.body,
      { pos: [0, y, z], rot: [angle, 0, 0] });
    const dy = Math.cos(angle) * segLen, dz = Math.sin(angle) * segLen;
    y -= dy; z += dz;
  }
  // Plancher de chargeur + levre d'alimentation.
  piece(parent, box(0.038, 0.022, 0.062), M.grip, { pos: [0, y + segLen / 2 - 0.004, z], rot: [angle, 0, 0] });
  piece(parent, box(0.031, 0.016, 0.05), M.metal, { pos: [0, 0.012, 0] });
  // Cartouche visible au sommet.
  piece(parent, cyl(0.0055, 0.0055, 0.03, 8), M.metal, { pos: [0, 0.018, 0.012], rot: [Math.PI / 2, 0, 0] });
}

/** Crosse : trois styles volumetriques. */
function buildStock(parent, M, P, shape, style) {
  parent.clear();
  const L = P.stock * (style === 'heavy' ? 1.1 : style === 'light' ? 0.92 : 1.0);
  if (style === 'light') {
    // Crosse squelette : tube + armature ajouree.
    piece(parent, cyl(0.018, 0.018, L, 10), M.metal, { pos: [0, 0.0, L / 2], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.03, 0.09, 0.016), M.body, { pos: [0, -0.01, L * 0.55] });
    piece(parent, box(0.03, 0.016, L * 0.6), M.body, { pos: [0, 0.035, L * 0.5] });
    piece(parent, box(0.03, 0.016, L * 0.6), M.body, { pos: [0, -0.055, L * 0.5] });
    piece(parent, box(0.042, 0.1, 0.022), M.rubber, { pos: [0, -0.012, L + 0.008] });
  } else if (style === 'heavy') {
    // Crosse tactique massive : corps plein, joue haute, large plaque.
    piece(parent, cyl(0.02, 0.02, L * 0.45, 10), M.metal, { pos: [0, 0, L * 0.22], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.058, 0.1, L * 0.62, 2), M.body, { pos: [0, -0.012, L * 0.6] });
    piece(parent, cyl(0.03, 0.028, L * 0.6, 12), M.body, { pos: [0, 0.028, L * 0.6], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.05, 0.035, L * 0.5), M.grip, { pos: [0, 0.052, L * 0.62] });      // appui-joue
    piece(parent, box(0.062, 0.125, 0.028), M.rubber, { pos: [0, -0.012, L + 0.012] });   // plaque de couche
    piece(parent, box(0.03, 0.03, 0.05), M.body, { pos: [0, -0.062, L * 0.78] });         // monopode
    for (let i = 0; i < 4; i++) {
      piece(parent, box(0.022, 0.012, 0.01), M.metal, { pos: [0, -0.06, L * 0.3 + i * 0.03] });
    }
  } else if (shape === 'ak') {
    // Crosse pleine type AK.
    piece(parent, box(0.05, 0.085, L, 2), M.body, { pos: [0, -0.012, L / 2], rot: [-0.06, 0, 0] });
    piece(parent, cyl(0.028, 0.026, L * 0.9, 12), M.body, { pos: [0, 0.02, L * 0.5], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.052, 0.1, 0.022), M.rubber, { pos: [0, -0.03, L + 0.008] });
  } else {
    // Crosse telescopique standard.
    piece(parent, cyl(0.019, 0.019, L * 0.9, 10), M.metal, { pos: [0, 0, L * 0.42], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.05, 0.085, L * 0.5, 2), M.body, { pos: [0, -0.008, L * 0.66] });
    piece(parent, cyl(0.026, 0.024, L * 0.48, 12), M.body, { pos: [0, 0.022, L * 0.66], rot: [Math.PI / 2, 0, 0] });
    piece(parent, box(0.054, 0.108, 0.024), M.rubber, { pos: [0, -0.008, L * 0.9 + 0.014] });
    piece(parent, box(0.03, 0.028, 0.045), M.body, { pos: [0, -0.052, L * 0.74] });
  }
  finalize(parent);
}

/* =======================================================================
 *  ACCESSOIRES (Gunsmith)
 * ===================================================================== */

const LENS = () => new THREE.MeshPhysicalMaterial({
  color: 0x0d2230, metalness: 0.05, roughness: 0.04,
  transmission: 0.7, thickness: 0.004, ior: 1.5, transparent: true, opacity: 0.9,
});

/**
 * Cree un accessoire 3D volumetrique.
 * @param {string} slot  optic|barrel|muzzle|stock|laser|grip|mag
 * @param {string} id    identifiant (cf. shared/weapons.json)
 * @param {object} ctx   { M, P, shape, camo }
 */
export function buildAttachment(slot, id, ctx) {
  const { M, P, shape } = ctx;
  const g = new THREE.Group();
  g.name = `att:${slot}:${id}`;

  if (slot === 'optic') {
    if (id === 'reddot') {
      // Point rouge compact : embase, tube ouvert, lentille teintee, point emissif.
      piece(g, box(0.034, 0.022, 0.05), M.metal, { pos: [0, 0.011, 0] });
      piece(g, box(0.04, 0.028, 0.044), M.body, { pos: [0, 0.042, 0] });
      piece(g, cyl(0.016, 0.016, 0.044, 14, true), M.body, { pos: [0, 0.046, 0], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.0145, 0.0145, 0.004, 14), LENS(), { pos: [0, 0.046, -0.02], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.0145, 0.0145, 0.004, 14), LENS(), { pos: [0, 0.046, 0.021], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.006, 0.006, 0.01, 8), M.metal, { pos: [0.018, 0.05, 0.004], rot: [0, 0, Math.PI / 2] });
      const dot = new THREE.Mesh(sph(0.0022, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
      dot.position.set(0, 0.046, -0.015);
      dot.userData.noMerge = true;
      g.add(dot);
      g.userData.sightHeight = 0.046;
    } else if (id === 'holo') {
      piece(g, box(0.036, 0.02, 0.07), M.metal, { pos: [0, 0.01, 0] });
      piece(g, box(0.044, 0.046, 0.072, 2), M.body, { pos: [0, 0.044, 0.004] });
      piece(g, box(0.038, 0.036, 0.004), LENS(), { pos: [0, 0.048, -0.032] });
      piece(g, box(0.03, 0.012, 0.016), M.metal, { pos: [0, 0.07, 0.022] });
      for (let i = 0; i < 2; i++) piece(g, box(0.008, 0.008, 0.008), M.rubber, { pos: [0.02, 0.03, 0.01 + i * 0.014] });
      const ret = new THREE.Mesh(torus(0.009, 0.0012, 5, 16), new THREE.MeshBasicMaterial({ color: 0xff3020 }));
      ret.position.set(0, 0.048, -0.03);
      ret.userData.noMerge = true;
      g.add(ret);
      g.userData.sightHeight = 0.048;
    } else if (id === 'acog') {
      // Lunette 3.4x : corps long, cloche d'objectif, pare-soleil, tourelles.
      piece(g, box(0.038, 0.02, 0.08), M.metal, { pos: [0, 0.01, 0.01] });
      for (const z of [-0.03, 0.04]) piece(g, box(0.042, 0.03, 0.022), M.metal, { pos: [0, 0.032, z] });
      piece(g, cyl(0.019, 0.019, 0.17, 16), M.body, { pos: [0, 0.055, -0.01], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.027, 0.022, 0.05, 16), M.body, { pos: [0, 0.055, -0.1], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.028, 0.028, 0.02, 16, true), M.rubber, { pos: [0, 0.055, -0.132], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.0245, 0.0245, 0.004, 16), LENS(), { pos: [0, 0.055, -0.118], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.024, 0.02, 0.035, 16), M.rubber, { pos: [0, 0.055, 0.085], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.0175, 0.0175, 0.004, 16), LENS(), { pos: [0, 0.055, 0.07], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.012, 0.012, 0.016, 10), M.metal, { pos: [0, 0.076, 0.01] });
      piece(g, cyl(0.012, 0.012, 0.016, 10), M.metal, { pos: [0.021, 0.055, 0.01], rot: [0, 0, Math.PI / 2] });
      const cross = new THREE.Mesh(torus(0.004, 0.0008, 4, 12), new THREE.MeshBasicMaterial({ color: 0xff4028 }));
      cross.position.set(0, 0.055, 0.06);
      cross.userData.noMerge = true;
      g.add(cross);
      g.userData.sightHeight = 0.055;
      g.userData.scope = true;
    }
  } else if (slot === 'muzzle') {
    if (id === 'comp') {
      piece(g, cyl(0.016, 0.016, 0.052, 14), M.metal, { pos: [0, 0, -0.026], rot: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 3; i++) {
        for (const sx of [-1, 1]) {
          piece(g, box(0.006, 0.02, 0.008), M.metal, { pos: [sx * 0.013, 0.004, -0.014 - i * 0.013] });
        }
      }
      piece(g, cyl(0.0175, 0.0175, 0.008, 14), M.metal, { pos: [0, 0, -0.05], rot: [Math.PI / 2, 0, 0] });
    } else if (id === 'suppressor') {
      // Silencieux : long tube epais + chicanes visibles aux extremites.
      piece(g, cyl(0.0225, 0.0225, 0.165, 18), M.metal, { pos: [0, 0, -0.082], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.024, 0.024, 0.016, 18), M.metal, { pos: [0, 0, -0.012], rot: [Math.PI / 2, 0, 0] });
      piece(g, cyl(0.024, 0.021, 0.018, 18), M.metal, { pos: [0, 0, -0.158], rot: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 6; i++) {
        piece(g, cyl(0.0232, 0.0232, 0.004, 18), M.rubber, { pos: [0, 0, -0.03 - i * 0.022], rot: [Math.PI / 2, 0, 0] });
      }
    } else if (id === 'brake') {
      piece(g, cyl(0.019, 0.019, 0.062, 14), M.metal, { pos: [0, 0, -0.031], rot: [Math.PI / 2, 0, 0] });
      for (let i = 0; i < 4; i++) {
        piece(g, box(0.042, 0.006, 0.007), M.metal, { pos: [0, 0.0, -0.014 - i * 0.013] });
      }
      piece(g, cyl(0.021, 0.014, 0.012, 14), M.metal, { pos: [0, 0, -0.06], rot: [Math.PI / 2, 0, 0] });
    }
  } else if (slot === 'barrel') {
    const extra = id === 'long' ? 0.12 : -0.06;
    const len = Math.max(0.05, P.barrel * 0.35 + extra);
    piece(g, cyl(P.barrelR * 0.95, P.barrelR * 0.95, len, 12), M.metal,
      { pos: [0, 0, -len / 2], rot: [Math.PI / 2, 0, 0] });
    piece(g, cyl(P.barrelR * 1.3, P.barrelR * 1.3, 0.016, 12), M.metal,
      { pos: [0, 0, -0.008], rot: [Math.PI / 2, 0, 0] });
    if (id === 'long') {
      // Manchon cannele du canon lourd.
      for (let i = 0; i < 5; i++) {
        piece(g, cyl(P.barrelR * 1.18, P.barrelR * 1.18, 0.006, 12), M.metal,
          { pos: [0, 0, -0.03 - i * 0.02], rot: [Math.PI / 2, 0, 0] });
      }
    }
    g.userData.lengthDelta = -len;     // decale le socket de bouche
  } else if (slot === 'stock') {
    // Gere par buildStock (remplace la crosse d'origine).
    g.userData.stockStyle = id;
  } else if (slot === 'laser') {
    const col = id === 'laser1' ? 0xff2a1a : 0x25d0a0;
    piece(g, box(0.03, 0.028, 0.058, 1), M.body, { pos: [-0.006, 0, 0] });
    piece(g, box(0.014, 0.016, 0.03), M.metal, { pos: [-0.018, 0, -0.03] });
    piece(g, cyl(0.005, 0.005, 0.01, 8), M.metal, { pos: [-0.018, 0, -0.048], rot: [Math.PI / 2, 0, 0] });
    piece(g, box(0.012, 0.01, 0.012), M.rubber, { pos: [-0.006, 0.016, 0.02] });
    const emitter = new THREE.Mesh(sph(0.0035, 8, 6), new THREE.MeshBasicMaterial({ color: col }));
    emitter.position.set(-0.018, 0, -0.053);
    emitter.userData.noMerge = true;
    emitter.name = 'laserEmitter';
    g.add(emitter);
    g.userData.laserColor = col;
    g.userData.visibleBeam = id === 'laser1';
  } else if (slot === 'grip') {
    if (id === 'vertical') {
      piece(g, box(0.03, 0.022, 0.034), M.metal, { pos: [0, 0.006, 0] });
      piece(g, cyl(0.016, 0.019, 0.085, 12), M.grip, { pos: [0, -0.048, 0] });
      piece(g, cyl(0.021, 0.021, 0.014, 12), M.grip, { pos: [0, -0.092, 0] });
      for (let i = 0; i < 3; i++) piece(g, torus(0.018, 0.0025, 5, 12), M.grip, { pos: [0, -0.03 - i * 0.02, 0], rot: [Math.PI / 2, 0, 0] });
    } else {
      piece(g, box(0.03, 0.02, 0.04), M.metal, { pos: [0, 0.006, 0] });
      piece(g, box(0.026, 0.028, 0.075, 1), M.grip, { pos: [0, -0.03, -0.022], rot: [-0.72, 0, 0] });
      piece(g, box(0.03, 0.016, 0.022), M.grip, { pos: [0, -0.055, -0.048] });
    }
  } else if (slot === 'mag') {
    // Le chargeur etendu est reconstruit a la bonne longueur.
    g.userData.magLengthMul = id === 'ext' ? 1.38 : 1.0;
    if (id === 'fast') {
      piece(g, box(0.042, 0.02, 0.064), M.rubber, { pos: [0, -P.magLen * 0.92, P.magCurve * 0.5] });
    }
  }

  finalize(g);
  return g;
}

/** (Re)applique un jeu complet d'accessoires sur une arme deja construite. */
export function applyAttachments(weapon, attachments = {}, camo = null) {
  const sockets = weapon.userData.sockets;
  const M = weapon.userData.materials;
  const P = weapon.userData.params;
  const shape = weapon.userData.shape;
  const ctx = { M, P, shape, camo };

  // Nettoyage des accessoires precedents.
  for (const [slot, node] of Object.entries(weapon.userData.attached)) {
    node.parent?.remove(node);
    delete weapon.userData.attached[slot];
  }
  weapon.userData.sightHeight = P.recH / 2 + 0.047;
  weapon.userData.hasScope = false;
  weapon.userData.laser = null;

  let muzzleShift = 0;

  for (const slot of ['barrel', 'muzzle', 'optic', 'stock', 'laser', 'grip', 'mag']) {
    const id = attachments[slot];
    if (!id) continue;
    const node = buildAttachment(slot, id, ctx);

    if (slot === 'stock') {
      buildStock(weapon.userData.stockGroup, M, P, shape, node.userData.stockStyle);
      weapon.userData.attached.stock = weapon.userData.stockGroup;
      continue;
    }
    if (slot === 'mag') {
      weapon.userData.magGroup.clear();
      buildMagazine(weapon.userData.magGroup, M, P, shape, node.userData.magLengthMul);
      if (node.children.length) weapon.userData.magGroup.add(node);
      finalize(weapon.userData.magGroup);
      weapon.userData.attached.mag = weapon.userData.magGroup;
      continue;
    }

    if (slot === 'barrel') {
      muzzleShift = node.userData.lengthDelta || 0;
      sockets.barrel.add(node);
      sockets.muzzle.position.z = sockets.barrel.position.z + muzzleShift;
      sockets.muzzleTip.position.z = sockets.muzzle.position.z - 0.01;
    } else if (slot === 'muzzle') {
      sockets.muzzle.add(node);
      const extra = id === 'suppressor' ? 0.17 : id === 'brake' ? 0.07 : 0.06;
      sockets.muzzleTip.position.z = sockets.muzzle.position.z - extra;
    } else if (slot === 'optic') {
      sockets.optic.add(node);
      weapon.userData.sightHeight = sockets.optic.position.y + (node.userData.sightHeight || 0.045);
      weapon.userData.hasScope = !!node.userData.scope;
      sockets.sightLine.position.y = weapon.userData.sightHeight;
      sockets.sightLine.position.z = sockets.optic.position.z;
    } else if (slot === 'laser') {
      sockets.laser.add(node);
      weapon.userData.laser = {
        node,
        color: node.userData.laserColor,
        beam: node.userData.visibleBeam,
      };
    } else if (slot === 'grip') {
      sockets.grip.add(node);
    }
    weapon.userData.attached[slot] = node;
  }
  sockets.sightLine.position.y = weapon.userData.sightHeight;
  return weapon;
}


/* =======================================================================
 *  RESOLUTION APRES CLONAGE
 *
 *  THREE.Object3D.clone() serialise userData en JSON : les references vers des
 *  Group (rig, sockets) y deviennent des objets inertes. On les retrouve donc
 *  par nom sur le clone, puis on reconstruit userData.
 * ===================================================================== */

/** Reconstruit userData.rig d'un operateur clone. @returns {object} le rig */
export function resolveRig(root) {
  const find = (n) => root.getObjectByName('rig:' + n);
  const limb = (prefix, parts) => {
    const out = {};
    for (const part of parts) out[part] = find(`${prefix}.${part}`);
    return out;
  };
  const rig = {
    hips: find('hips'), spine: find('spine'), head: find('head'), vest: find('vest'),
    armL: limb('armL', ['shoulder', 'upper', 'fore', 'hand']),
    armR: limb('armR', ['shoulder', 'upper', 'fore', 'hand']),
    legL: limb('legL', ['hip', 'thigh', 'shin', 'foot']),
    legR: limb('legR', ['hip', 'thigh', 'shin', 'foot']),
  };
  for (const [key, node] of Object.entries(rig)) {
    if (!node) throw new Error(`rig incomplet: ${key} introuvable`);
    if (typeof node.add !== 'function') {
      for (const [sub, n2] of Object.entries(node)) {
        if (!n2) throw new Error(`rig incomplet: ${key}.${sub} introuvable`);
      }
    }
  }
  root.userData.rig = rig;
  root.userData.isOperator = true;
  return rig;
}

/** Reconstruit userData.sockets d'une arme clonee. @returns {object} */
export function resolveSockets(root) {
  const sockets = {};
  for (const name of ['optic', 'muzzle', 'barrel', 'stock', 'laser', 'grip', 'mag',
                      'muzzleTip', 'ejectPort', 'sightLine']) {
    const node = root.getObjectByName('socket:' + name);
    if (!node) throw new Error(`socket introuvable: ${name}`);
    sockets[name] = node;
  }
  root.userData.sockets = sockets;
  root.userData.magGroup = root.getObjectByName('weapon:mag');
  root.userData.stockGroup = root.getObjectByName('weapon:stock');
  return sockets;
}

/* =======================================================================
 *  BRAS 1ERE PERSONNE
 * ===================================================================== */

/**
 * Avant-bras et mains gantees tenant l'arme (vue FPS).
 * @returns {THREE.Group} userData = { left, right } (groupes orientables)
 */
export function buildFirstPersonArms(opts = {}) {
  const camo = opts.camo || null;
  const M = {
    sleeve: camo ? camoMaterial(camo, { repeat: [2, 3] }) : material('fabric', { repeat: [2, 3] }),
    glove:  material('rubber', { repeat: [2, 2] }),
    hard:   material('polymer', { repeat: [1, 1] }),
    skin:   material('skin', { repeat: [1, 1] }),
    vest:   material('cordura', { repeat: [1, 1] }),
  };

  const root = new THREE.Group();
  const made = {};

  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? -1 : 1;
    const arm = new THREE.Group();
    arm.name = `fpArm${side}`;
    root.add(arm);

    // Avant-bras epais : manche + poignet renforce.
    piece(arm, cap(0.062, 0.2, 12, 6), M.sleeve, { pos: [0, 0, 0.14], rot: [Math.PI / 2, 0, 0] });
    piece(arm, cyl(0.068, 0.058, 0.06, 12), M.sleeve, { pos: [0, 0, 0.02], rot: [Math.PI / 2, 0, 0] });
    piece(arm, cyl(0.057, 0.052, 0.045, 12), M.vest, { pos: [0, 0, -0.012], rot: [Math.PI / 2, 0, 0] });
    piece(arm, box(0.07, 0.03, 0.05), M.hard, { pos: [0, 0.03, 0.07] });     // protection d'avant-bras
    piece(arm, cyl(0.064, 0.066, 0.05, 12), M.sleeve, { pos: [0, 0, 0.24], rot: [Math.PI / 2, 0, 0] });

    // Main gantee : paume epaisse, dos renforce, doigts.
    // Les doigts s'enroulent autour de l'axe X ; pour la main avant (qui tient
    // un garde-main oriente selon Z) on fera tourner ce groupe d'un quart de tour.
    const hand = new THREE.Group();
    hand.name = `fpHand${side}`;
    hand.position.set(0, 0, -0.055);
    arm.add(hand);
    piece(hand, box(0.082, 0.052, 0.1, 1), M.glove, { pos: [0, 0, 0] });
    piece(hand, box(0.088, 0.022, 0.085), M.hard, { pos: [0, 0.03, 0.004] });
    piece(hand, cyl(0.026, 0.03, 0.09, 10), M.glove, { pos: [0, -0.004, 0.01], rot: [Math.PI / 2, 0, 0] });
    // Quatre doigts replies (groupes deux a deux) + pouce.
    for (let i = 0; i < 4; i++) {
      piece(hand, box(0.019, 0.026, 0.055), M.glove,
        { pos: [(i - 1.5) * 0.021, -0.022, -0.038], rot: [-0.85, 0, 0] });
      piece(hand, box(0.02, 0.024, 0.03), M.glove,
        { pos: [(i - 1.5) * 0.021, -0.045, -0.06], rot: [-1.9, 0, 0] });
    }
    piece(hand, box(0.026, 0.03, 0.055), M.glove,
      { pos: [sx * 0.042, 0.0, -0.028], rot: [-0.5, 0, sx * 0.55] });
    piece(hand, box(0.022, 0.024, 0.032), M.glove,
      { pos: [sx * 0.05, -0.012, -0.058], rot: [-1.1, 0, sx * 0.7] });
    // Petit bout de peau au poignet (realisme, cf. reference FPS).
    piece(arm, cyl(0.05, 0.05, 0.02, 12), M.skin, { pos: [0, 0, -0.03], rot: [Math.PI / 2, 0, 0] });
    made[side === 'L' ? 'left' : 'right'] = { arm, hand };
  }

  finalize(root);
  root.userData.arms = made;
  return root;
}

/* =======================================================================
 *  PROPS DE L'ARENE
 * ===================================================================== */

/** Caisse en bois cerclee. */
export function buildCrate() {
  const g = new THREE.Group();
  const wood = material('crate_wood', { repeat: [2, 2] });
  const metal = material('gunmetal', { repeat: [1, 1] });
  piece(g, box(0.9, 0.9, 0.9, 2), wood, { pos: [0, 0, 0] });
  for (const axis of ['x', 'z']) {
    for (const s of [-1, 1]) {
      const pos = axis === 'x' ? [s * 0.455, 0, 0] : [0, 0, s * 0.455];
      piece(g, box(axis === 'x' ? 0.02 : 0.84, 0.08, axis === 'x' ? 0.84 : 0.02), metal, { pos });
    }
  }
  for (const s of [-1, 1]) piece(g, box(0.92, 0.06, 0.92), metal, { pos: [0, s * 0.42, 0] });
  return finalize(g);
}

/** Fut metallique a nervures. */
export function buildBarrel() {
  const g = new THREE.Group();
  const mat = material('barrel', { repeat: [2, 1] });
  piece(g, cyl(0.29, 0.29, 1.12, 18), mat, { pos: [0, 0, 0] });
  for (const y of [-0.34, 0, 0.34]) piece(g, cyl(0.305, 0.305, 0.055, 18), mat, { pos: [0, y, 0] });
  piece(g, cyl(0.3, 0.3, 0.04, 18), mat, { pos: [0, 0.56, 0] });
  piece(g, cyl(0.07, 0.07, 0.03, 10), material('gunmetal'), { pos: [0.13, 0.58, 0] });
  return finalize(g);
}

/** Palette de manutention. */
export function buildPallet() {
  const g = new THREE.Group();
  const wood = material('crate_wood', { repeat: [1, 1] });
  for (let i = 0; i < 6; i++) piece(g, box(1.2, 0.025, 0.12), wood, { pos: [0, 0.065, -0.5 + i * 0.2] });
  for (let i = 0; i < 3; i++) piece(g, box(0.1, 0.07, 1.1), wood, { pos: [-0.5 + i * 0.5, 0.02, 0] });
  for (let i = 0; i < 3; i++) piece(g, box(1.2, 0.02, 0.12), wood, { pos: [0, -0.02, -0.45 + i * 0.45] });
  return finalize(g);
}

/** Debris plats (papiers, eclats) : purement decoratif, sans ombre. */
export function buildDebris() {
  const g = new THREE.Group();
  const mat = material('concrete', { repeat: [1, 1] });
  piece(g, box(0.3, 0.012, 0.22), mat, { pos: [0, 0, 0], shadow: false });
  piece(g, box(0.16, 0.01, 0.3), mat, { pos: [0.1, 0.008, 0.08], rot: [0, 0.6, 0], shadow: false });
  const m = finalize(g);
  m.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return m;
}

/** Vehicule utilitaire (couverture). */
export function buildVehicle(sub = 'van', matKey = 'van_white') {
  const g = new THREE.Group();
  const bodyMat = material(matKey, { repeat: [2, 1] });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x1b242b, metalness: 0.1, roughness: 0.12,
    transmission: 0.45, thickness: 0.02, transparent: true, opacity: 0.8,
  });
  const tyre = material('rubber', { repeat: [2, 1] });
  const chrome = material('gunmetal', { repeat: [1, 1] });

  const isTruck = sub === 'truck';
  const L = isTruck ? 7.4 : 5.4;
  const H = isTruck ? 3.1 : 2.4;
  const W = 2.25;

  // Caisse principale + cabine distincte.
  piece(g, box(W, H * 0.72, L * 0.66, 2), bodyMat, { pos: [0, H * 0.14, -L * 0.14] });
  piece(g, box(W * 0.98, H * 0.46, L * 0.3, 2), bodyMat, { pos: [0, H * 0.02, L * 0.33] });
  piece(g, box(W * 0.9, H * 0.3, 0.06), glass, { pos: [0, H * 0.18, L * 0.47] });
  for (const sx of [-1, 1]) {
    piece(g, box(0.06, H * 0.22, L * 0.22), glass, { pos: [sx * W * 0.48, H * 0.14, L * 0.3] });
    piece(g, box(0.08, 0.12, 0.2), chrome, { pos: [sx * W * 0.52, H * 0.16, L * 0.42] });   // retroviseur
  }
  piece(g, box(W * 1.02, 0.18, 0.22), chrome, { pos: [0, -H * 0.26, L * 0.5] });            // pare-chocs
  piece(g, box(W * 1.02, 0.2, 0.2), chrome, { pos: [0, -H * 0.26, -L * 0.48] });
  for (const sx of [-1, 1]) {
    piece(g, box(0.26, 0.16, 0.08), material('gunmetal'), { pos: [sx * W * 0.34, -H * 0.1, L * 0.5] }); // phare
  }
  // Roues : jante + pneu.
  const axles = isTruck ? [-L * 0.3, L * 0.26, L * 0.02] : [-L * 0.26, L * 0.28];
  for (const z of axles) {
    for (const sx of [-1, 1]) {
      piece(g, cyl(0.42, 0.42, 0.26, 16), tyre, { pos: [sx * (W / 2 - 0.08), -H / 2 + 0.42, z], rot: [0, 0, Math.PI / 2] });
      piece(g, cyl(0.22, 0.22, 0.28, 12), chrome, { pos: [sx * (W / 2 - 0.08), -H / 2 + 0.42, z], rot: [0, 0, Math.PI / 2] });
    }
  }
  if (isTruck) {
    for (let i = 0; i < 5; i++) piece(g, box(W * 1.01, 0.08, 0.1), chrome, { pos: [0, H * 0.3 - i * 0.3, -L * 0.14] });
  }
  return finalize(g);
}

/** Muret jersey (base large, sommet etroit, chanfreins). */
export function buildJersey(w, h, d) {
  const g = new THREE.Group();
  const mat = material('concrete_barrier', { repeat: [2, 1] });
  const along = w > d;
  const len = along ? w : d;
  const thick = along ? d : w;
  const dims = (t, hh) => (along ? [len, hh, t] : [t, hh, len]);
  piece(g, box(...dims(thick, h * 0.3)), mat, { pos: [0, -h * 0.35, 0] });
  piece(g, box(...dims(thick * 0.78, h * 0.42)), mat, { pos: [0, -h * 0.02, 0] });
  piece(g, box(...dims(thick * 0.55, h * 0.3)), mat, { pos: [0, h * 0.35, 0] });
  // Anneaux de levage.
  for (const s of [-0.3, 0.3]) {
    const p = along ? [len * s, h * 0.5, 0] : [0, h * 0.5, len * s];
    piece(g, torus(0.05, 0.012, 6, 10), material('gunmetal'), { pos: p, rot: [0, along ? 0 : Math.PI / 2, 0] });
  }
  return finalize(g);
}

/** Conteneur : nervures, portes, cornieres. */
export function buildContainer(w, h, d, matKey) {
  const g = new THREE.Group();
  const mat = material(matKey, { repeat: [Math.max(w, d) / 3, 1] });
  const metal = material('gunmetal', { repeat: [1, 1] });
  piece(g, box(w, h, d, 2), mat, { pos: [0, 0, 0] });
  // Cornieres d'angle (les huit coins d'un vrai conteneur).
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    piece(g, box(0.13, h, 0.13), metal, { pos: [sx * (w / 2 - 0.05), 0, sz * (d / 2 - 0.05)] });
    for (const sy of [-1, 1]) {
      piece(g, box(0.2, 0.16, 0.2), metal, { pos: [sx * (w / 2 - 0.08), sy * (h / 2 - 0.06), sz * (d / 2 - 0.08)] });
    }
  }
  // Portes + barres de verrouillage sur la petite face.
  const doorZ = d > w ? [0, 0, d / 2] : [w / 2, 0, 0];
  const doorRot = d > w ? [0, 0, 0] : [0, Math.PI / 2, 0];
  const door = new THREE.Group();
  door.position.set(doorZ[0] * 1.002, 0, doorZ[2] * 1.002);
  door.rotation.set(doorRot[0], doorRot[1], doorRot[2]);
  g.add(door);
  const dw = (d > w ? w : d) * 0.94;
  for (const sx of [-1, 1]) {
    piece(door, box(dw / 2 - 0.02, h * 0.9, 0.04), mat, { pos: [sx * dw / 4, 0, 0.02] });
    for (const bx of [0.3, 0.7]) {
      piece(door, cyl(0.018, 0.018, h * 0.88, 8), metal, { pos: [sx * dw * (bx - 0.5) * 0.5, 0, 0.05] });
      piece(door, box(0.07, 0.07, 0.05), metal, { pos: [sx * dw * (bx - 0.5) * 0.5, -0.02, 0.07] });
    }
  }
  return finalize(g);
}
