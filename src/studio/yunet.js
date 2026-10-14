/**
 * Détection de visages : YuNet (OpenCV Zoo, licence MIT, 230 Ko), exécuté par le moteur de nn.js (JavaScript + WebAssembly SIMD).
 * Le réseau accepte n'importe quelle définition multiple de 32 ; on l'utilise en petite définition car un visage d'interview y
 * reste grand.
 *
 *   const net = loadYunet();
 *   const faces = net.detect(rgb, 384, 224);   // rgb : Uint8Array w*h*3 → [{ x, y, w, h, score, kps }] en pixels
 *
 * `kps` : cinq repères du visage [[x, y], …] : œil gauche de l'image, œil droit, bout du nez, coins gauche et droit de la bouche.
 */
import { loadModel } from './nn.js';

const MODEL_URL = new URL('./models/face_detection_yunet_2023mar.onnx', import.meta.url);

export function loadYunet(file = MODEL_URL) {
  const model = loadModel(file);

  /** Sorties brutes du réseau pour une image CHW (BVR, valeurs 0..255). */
  const forward = (input, width, height) => model.run({ input: { dims: [3, height, width], data: input } });

  /** rgb : Uint8Array (RVB entrelacé), width et height multiples de 32. Renvoie les visages triés par score décroissant. */
  function detect(rgb, width, height, { threshold = 0.6, nms = 0.3 } = {}) {
    const input = new Float32Array(3 * width * height);
    const plane = width * height;
    for (let i = 0; i < plane; i++) { // le réseau attend du BVR, valeurs 0..255
      input[i] = rgb[i * 3 + 2];
      input[plane + i] = rgb[i * 3 + 1];
      input[2 * plane + i] = rgb[i * 3];
    }
    const out = forward(input, width, height);
    const found = [];
    for (const stride of [8, 16, 32]) {
      const cls = out[`cls_${stride}`].data;
      const obj = out[`obj_${stride}`].data;
      const box = out[`bbox_${stride}`].data;
      const kps = out[`kps_${stride}`].data;
      const cols = width / stride;
      for (let i = 0; i < cls.length; i++) {
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (score < threshold) continue;
        const r = Math.floor(i / cols);
        const c = i % cols;
        const w = Math.exp(box[i * 4 + 2]) * stride;
        const h = Math.exp(box[i * 4 + 3]) * stride;
        found.push({
          x: (c + box[i * 4]) * stride - w / 2,
          y: (r + box[i * 4 + 1]) * stride - h / 2,
          w,
          h,
          score,
          kps: Array.from({ length: 5 }, (_, n) => [(c + kps[i * 10 + 2 * n]) * stride, (r + kps[i * 10 + 2 * n + 1]) * stride]),
        });
      }
    }
    found.sort((p, q) => q.score - p.score);
    const kept = [];
    for (const f of found) {
      const dup = kept.some((k) => {
        const iw = Math.min(f.x + f.w, k.x + k.w) - Math.max(f.x, k.x);
        const ih = Math.min(f.y + f.h, k.y + k.h) - Math.max(f.y, k.y);
        if (iw <= 0 || ih <= 0) return false;
        const inter = iw * ih;
        return inter / (f.w * f.h + k.w * k.h - inter) > nms;
      });
      if (!dup) kept.push(f);
    }
    return kept;
  }

  return { detect, forward };
}
