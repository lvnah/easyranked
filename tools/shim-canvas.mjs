/**
 * EasyRanked :: shim de canvas 2D pour les tests Node.
 *
 * textures.js peint ses materiaux sur des <canvas> ; ce stub permet d'importer
 * la chaine complete (textures -> visuals -> weapons -> player) dans Node, pour
 * tester la logique de jeu sans navigateur ni GPU. Les contextes ne dessinent
 * rien : seules les dimensions et les ImageData sont credibles.
 */
const makeImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });

function fakeContext(canvas) {
  const ctx = {
    canvas,
    createImageData: (w, h) => makeImageData(w, h),
    getImageData: (x, y, w, h) => makeImageData(w, h),
    putImageData: () => {},
    createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    measureText: () => ({ width: 10 }),
  };
  for (const m of ['fillRect','clearRect','strokeRect','beginPath','closePath','moveTo','lineTo',
                   'quadraticCurveTo','bezierCurveTo','arc','arcTo','ellipse','rect','roundRect',
                   'fill','stroke','save','restore','translate','rotate','scale','setTransform',
                   'clip','fillText','strokeText','drawImage','setLineDash']) {
    ctx[m] = () => ctx;
  }
  return ctx;
}

globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') return { style: {}, appendChild() {}, setAttribute() {} };
    const canvas = { width: 1, height: 1, style: {}, getContext: () => fakeContext(canvas),
                     addEventListener() {}, removeEventListener() {} };
    return canvas;
  },
  addEventListener() {}, removeEventListener() {},
  getElementById: () => null,
  querySelector: () => null,
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {},
                      innerWidth: 1280, innerHeight: 720 };
globalThis.performance ??= { now: () => Date.now() };
