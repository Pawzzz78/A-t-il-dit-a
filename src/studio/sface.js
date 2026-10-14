/**
 * Reconnaissance de visages : SFace (OpenCV Zoo, licence Apache 2.0, 39 Mo), exécuté par le moteur de nn.js.
 *
 * Un visage détecté (avec ses cinq repères, voir yunet.js) est redressé en une vignette de 112 × 112 pixels (`alignFace`), puis
 * transformé en empreinte de 128 nombres (`embed`). Deux photos de la même personne donnent des empreintes proches : leur
 * similarité cosinus dépasse environ 0,36 (seuil recommandé par OpenCV pour SFace).
 */
import { loadModel } from './nn.js';

const MODEL_URL = new URL('./models/face_recognition_sface_2021dec.onnx', import.meta.url);

/** Similarité cosinus au-dessus de laquelle deux empreintes sont celles de la même personne (seuil d'OpenCV pour SFace). */
export const SAME_PERSON = 0.363;

// position des repères dans la vignette 112 × 112 (modèle ArcFace : œil gauche de l'image, œil droit, nez, coins de la bouche)
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
export const FACE_SIZE = 112;

/**
 * Vignette 112 × 112 (RVB entrelacé) du visage dont les repères sont `kps` ([[x, y] × 5] en pixels de l'image `rgb`, w × h).
 * Transformation de similarité (rotation, échelle, translation) qui amène les repères sur le modèle, au sens des moindres carrés.
 */
export function alignFace(rgb, w, h, kps) {
  const n = TEMPLATE.length;
  const mean = (pts, k) => pts.reduce((s, p) => s + p[k], 0) / n;
  const [sx, sy, tx, ty] = [mean(kps, 0), mean(kps, 1), mean(TEMPLATE, 0), mean(TEMPLATE, 1)];
  let num1 = 0;
  let num2 = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const [x, y] = [kps[i][0] - sx, kps[i][1] - sy];
    const [u, v] = [TEMPLATE[i][0] - tx, TEMPLATE[i][1] - ty];
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  const a = num1 / den;
  const b = num2 / den;
  const det = a * a + b * b;
  const out = new Uint8Array(FACE_SIZE * FACE_SIZE * 3);
  for (let v = 0; v < FACE_SIZE; v++) {
    for (let u = 0; u < FACE_SIZE; u++) {
      // point de l'image d'origine qui arrive en (u, v) : inverse de x' = a·x − b·y + tx', y' = b·x + a·y + ty'
      const du = u - (tx - (a * sx - b * sy));
      const dv = v - (ty - (b * sx + a * sy));
      const x = (a * du + b * dv) / det;
      const y = (-b * du + a * dv) / det;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const fx = x - x0;
      const fy = y - y0;
      const o = (v * FACE_SIZE + u) * 3;
      for (let c = 0; c < 3; c++) {
        const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : rgb[(yy * w + xx) * 3 + c]);
        out[o + c] = Math.round(px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy);
      }
    }
  }
  return out;
}

export function loadSface(file = MODEL_URL) {
  const model = loadModel(file);
  /** Empreinte (128 nombres, norme 1) d'une vignette 112 × 112 produite par alignFace. */
  function embed(aligned) {
    const plane = FACE_SIZE * FACE_SIZE;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) { // le réseau attend du RVB, valeurs 0..255 (il centre et réduit lui-même)
      input[i] = aligned[i * 3];
      input[plane + i] = aligned[i * 3 + 1];
      input[2 * plane + i] = aligned[i * 3 + 2];
    }
    const { fc1 } = model.run({ data: { dims: [3, FACE_SIZE, FACE_SIZE], data: input } });
    const v = Float32Array.from(fc1.data);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
  return { embed };
}

/** Similarité cosinus de deux empreintes normalisées. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
