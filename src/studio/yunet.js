/**
 * Détection de visages : YuNet (OpenCV Zoo, licence MIT, 230 Ko) exécuté en JavaScript pur.
 *
 * Pas de bibliothèque native à installer : le fichier ONNX est lu ici (protobuf minimal) et seules les huit opérations du
 * réseau sont codées (Conv, Relu, MaxPool, Resize « nearest », Add, Transpose, Reshape, Sigmoid). Le réseau accepte n'importe
 * quelle définition multiple de 32 ; on l'utilise en petite définition (320 × 192) car un visage d'interview y reste grand.
 *
 *   const net = loadYunet();
 *   const faces = net.detect(rgb, 320, 192);   // rgb : Uint8Array w*h*3 → [{ x, y, w, h, score }] en pixels
 */
import { readFileSync } from 'node:fs';

const MODEL_URL = new URL('./models/face_detection_yunet_2023mar.onnx', import.meta.url);

// --- lecture du protobuf ONNX (seulement ce dont le réseau a besoin) --------------------------------------------------------

function reader(buf) {
  let p = 0;
  const varint = () => {
    let r = 0;
    let shift = 0;
    for (;;) {
      const b = buf[p++];
      r += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return r;
      shift += 7;
    }
  };
  return {
    get done() { return p >= buf.length; },
    field() {
      const key = varint();
      return { no: key >>> 3, type: key & 7 };
    },
    varint,
    bytes() {
      const n = varint();
      const out = buf.subarray(p, p + n);
      p += n;
      return out;
    },
    fixed32() {
      const v = new DataView(buf.buffer, buf.byteOffset + p, 4).getFloat32(0, true);
      p += 4;
      return v;
    },
    skip(type) {
      if (type === 0) varint();
      else if (type === 1) p += 8;
      else if (type === 2) {
        const n = varint();
        p += n;
      }
      else if (type === 5) p += 4;
      else throw new Error('Modèle ONNX illisible.');
    },
  };
}

function packedVarints(bytes) {
  const r = reader(bytes);
  const out = [];
  while (!r.done) out.push(r.varint());
  return out;
}

function parseTensor(bytes) {
  const r = reader(bytes);
  const t = { name: '', dims: [], dtype: 1, data: null };
  while (!r.done) {
    const { no, type } = r.field();
    if (no === 1) type === 2 ? t.dims.push(...packedVarints(r.bytes())) : t.dims.push(r.varint());
    else if (no === 2) t.dtype = r.varint();
    else if (no === 8) t.name = Buffer.from(r.bytes()).toString();
    else if (no === 9) {
      const raw = r.bytes();
      t.raw = raw;
    } else r.skip(type);
  }
  const n = t.dims.reduce((a, b) => a * b, 1);
  if (t.dtype === 1 && t.raw) {
    const copy = new Uint8Array(t.raw); // recopie : l'alignement du tampon d'origine n'est pas garanti
    t.data = new Float32Array(copy.buffer, 0, n);
  }
  delete t.raw;
  return t;
}

function parseNode(bytes) {
  const r = reader(bytes);
  const n = { op: '', inputs: [], outputs: [], attrs: {} };
  while (!r.done) {
    const { no, type } = r.field();
    if (no === 1) n.inputs.push(Buffer.from(r.bytes()).toString());
    else if (no === 2) n.outputs.push(Buffer.from(r.bytes()).toString());
    else if (no === 4) n.op = Buffer.from(r.bytes()).toString();
    else if (no === 5) {
      const a = reader(r.bytes());
      let name = '';
      let value;
      const ints = [];
      while (!a.done) {
        const f = a.field();
        if (f.no === 1) name = Buffer.from(a.bytes()).toString();
        else if (f.no === 2) value = a.fixed32();
        else if (f.no === 3) value = a.varint();
        else if (f.no === 4) value = Buffer.from(a.bytes()).toString();
        else if (f.no === 8) f.type === 2 ? ints.push(...packedVarints(a.bytes())) : ints.push(a.varint());
        else a.skip(f.type);
      }
      n.attrs[name] = ints.length ? ints : value;
    } else r.skip(type);
  }
  return n;
}

export function parseOnnx(buf) {
  const model = reader(buf);
  let graph = null;
  while (!model.done) {
    const { no, type } = model.field();
    if (no === 7) graph = model.bytes();
    else model.skip(type);
  }
  if (!graph) throw new Error('Modèle ONNX sans graphe.');
  const g = reader(graph);
  const nodes = [];
  const init = new Map();
  const outputs = [];
  while (!g.done) {
    const { no, type } = g.field();
    if (no === 1) nodes.push(parseNode(g.bytes()));
    else if (no === 5) {
      const t = parseTensor(g.bytes());
      init.set(t.name, t);
    } else if (no === 12) {
      const v = reader(g.bytes());
      while (!v.done) {
        const f = v.field();
        if (f.no === 1) outputs.push(Buffer.from(v.bytes()).toString());
        else v.skip(f.type);
      }
    } else g.skip(type);
  }
  return { nodes, init, outputs };
}

// --- opérations ---------------------------------------------------------------------------------------------------------------


/** Convolution 1 × 1 : produit matriciel, quatre canaux d'entrée à la fois (la sortie n'est relue qu'une fois sur quatre). */
function pointwise(x, w, b, y, cout, plane) {
  const cin = x.dims[0];
  const xd = x.data;
  const wd = w.data;
  const TILE = 512; // un morceau de plan à la fois : les données restent dans le cache du processeur
  for (let t0 = 0; t0 < plane; t0 += TILE) {
    const t1 = Math.min(plane, t0 + TILE);
    for (let oc = 0; oc < cout; oc++) {
      const yo = oc * plane;
      if (b) y.fill(b.data[oc], yo + t0, yo + t1);
      let ic = 0;
      for (; ic + 3 < cin; ic += 4) {
        const w0 = wd[oc * cin + ic];
        const w1 = wd[oc * cin + ic + 1];
        const w2 = wd[oc * cin + ic + 2];
        const w3 = wd[oc * cin + ic + 3];
        const a = ic * plane;
        const bb = a + plane;
        const c = bb + plane;
        const d = c + plane;
        for (let i = t0; i < t1; i++) y[yo + i] += w0 * xd[a + i] + w1 * xd[bb + i] + w2 * xd[c + i] + w3 * xd[d + i];
      }
      for (; ic < cin; ic++) {
        const wv = wd[oc * cin + ic];
        const a = ic * plane;
        for (let i = t0; i < t1; i++) y[yo + i] += wv * xd[a + i];
      }
    }
  }
  return { dims: [cout, x.dims[1], x.dims[2]], data: y };
}

/** Convolution 3 × 3 par canal (« depthwise »), pas 1, marge 1 : le plan est entouré de zéros pour éviter tout test dans la boucle. */
function depthwise(x, w, b, y) {
  const [ch, h, wd] = x.dims;
  const pw = wd + 2;
  const pad = new Float32Array((h + 2) * pw);
  for (let c = 0; c < ch; c++) {
    for (let r = 0; r < h; r++) pad.set(x.data.subarray(c * h * wd + r * wd, c * h * wd + (r + 1) * wd), (r + 1) * pw + 1);
    const k = w.data.subarray(c * 9, c * 9 + 9);
    const bias = b ? b.data[c] : 0;
    for (let r = 0; r < h; r++) {
      const o = c * h * wd + r * wd;
      const r0 = r * pw;
      const r1 = r0 + pw;
      const r2 = r1 + pw;
      for (let i = 0; i < wd; i++) {
        y[o + i] = bias + k[0] * pad[r0 + i] + k[1] * pad[r0 + i + 1] + k[2] * pad[r0 + i + 2] + k[3] * pad[r1 + i] + k[4] * pad[r1 + i + 1] + k[5] * pad[r1 + i + 2] + k[6] * pad[r2 + i] + k[7] * pad[r2 + i + 1] + k[8] * pad[r2 + i + 2];
      }
    }
  }
  return { dims: [ch, h, wd], data: y };
}

/** Convolution (groupes compris) ; x : [C, H, W]. */
function conv(x, w, b, attrs) {
  const [cin, h, wd] = x.dims;
  const [cout, cinPerGroup, kh, kw] = w.dims;
  const group = attrs.group ?? 1;
  const [sy, sx] = attrs.strides ?? [1, 1];
  const [pt, pl] = attrs.pads ?? [0, 0, 0, 0];
  const oh = Math.floor((h + 2 * pt - kh) / sy) + 1;
  const ow = Math.floor((wd + 2 * pl - kw) / sx) + 1;
  const y = new Float32Array(cout * oh * ow);
  if (kh === 1 && kw === 1 && sy === 1 && sx === 1 && pt === 0 && pl === 0 && group === 1) return pointwise(x, w, b, y, cout, h * wd);
  if (kh === 3 && kw === 3 && sy === 1 && sx === 1 && pt === 1 && pl === 1 && group === cin && cout === cin) return depthwise(x, w, b, y);
  const outPerGroup = cout / group;
  const xd = x.data;
  const wdta = w.data;
  const plane = h * wd;
  for (let oc = 0; oc < cout; oc++) {
    const g = Math.floor(oc / outPerGroup);
    const bias = b ? b.data[oc] : 0;
    const yo = oc * oh * ow;
    y.fill(bias, yo, yo + oh * ow);
    for (let icg = 0; icg < cinPerGroup; icg++) {
      const xi = (g * cinPerGroup + icg) * plane;
      const wi = (oc * cinPerGroup + icg) * kh * kw;
      for (let ky = 0; ky < kh; ky++) {
        for (let kx = 0; kx < kw; kx++) {
          const wv = wdta[wi + ky * kw + kx];
          if (wv === 0) continue;
          // colonnes de sortie pour lesquelles la colonne d'entrée existe
          const oxMin = Math.max(0, Math.ceil((pl - kx) / sx));
          const oxMax = Math.min(ow - 1, Math.floor((wd - 1 + pl - kx) / sx));
          for (let oy = 0; oy < oh; oy++) {
            const iy = oy * sy - pt + ky;
            if (iy < 0 || iy >= h) continue;
            const row = xi + iy * wd - pl + kx;
            const out = yo + oy * ow;
            for (let ox = oxMin; ox <= oxMax; ox++) y[out + ox] += xd[row + ox * sx] * wv;
          }
        }
      }
    }
  }
  void cin;
  return { dims: [cout, oh, ow], data: y };
}

function maxPool(x, attrs) {
  const [c, h, w] = x.dims;
  const [kh, kw] = attrs.kernel_shape;
  const [sy, sx] = attrs.strides ?? [kh, kw];
  const oh = Math.floor((h - kh) / sy) + 1;
  const ow = Math.floor((w - kw) / sx) + 1;
  const y = new Float32Array(c * oh * ow);
  for (let ch = 0; ch < c; ch++) {
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        let m = -Infinity;
        for (let ky = 0; ky < kh; ky++) for (let kx = 0; kx < kw; kx++) m = Math.max(m, x.data[ch * h * w + (oy * sy + ky) * w + ox * sx + kx]);
        y[ch * oh * ow + oy * ow + ox] = m;
      }
    }
  }
  return { dims: [c, oh, ow], data: y };
}

function resizeNearest(x, scales) {
  const [c, h, w] = x.dims;
  const fy = scales[2];
  const fx = scales[3];
  const oh = Math.floor(h * fy);
  const ow = Math.floor(w * fx);
  const y = new Float32Array(c * oh * ow);
  for (let ch = 0; ch < c; ch++) {
    for (let oy = 0; oy < oh; oy++) {
      const iy = Math.min(h - 1, Math.floor(oy / fy));
      for (let ox = 0; ox < ow; ox++) y[ch * oh * ow + oy * ow + ox] = x.data[ch * h * w + iy * w + Math.min(w - 1, Math.floor(ox / fx))];
    }
  }
  return { dims: [c, oh, ow], data: y };
}

// --- réseau -------------------------------------------------------------------------------------------------------------------

/**
 * Charge YuNet. Les tenseurs sont stockés sans la dimension de lot : [C, H, W]. Les têtes de sortie (Transpose puis Reshape en
 * [1, H*W, C]) deviennent des tableaux « cellule par cellule » ; le fichier fixe 640 × 640 dans ses Reshape, que l'on ignore
 * pour accepter d'autres définitions.
 */
export function loadYunet(file = MODEL_URL) {
  const { nodes, init, outputs } = parseOnnx(new Uint8Array(readFileSync(file)));

  function forward(input, width, height) {
    const t = new Map();
    t.set('input', { dims: [3, height, width], data: input });
    const get = (name) => t.get(name) ?? init.get(name);
    for (const n of nodes) {
      const [a, b, c] = n.inputs;
      let out;
      switch (n.op) {
        case 'Conv': out = conv(get(a), get(b), n.inputs.length > 2 ? get(c) : null, n.attrs); break;
        case 'Relu': { const x = get(a); const d = new Float32Array(x.data.length); for (let i = 0; i < d.length; i++) d[i] = x.data[i] > 0 ? x.data[i] : 0; out = { dims: x.dims, data: d }; break; }
        case 'Sigmoid': { const x = get(a); const d = new Float32Array(x.data.length); for (let i = 0; i < d.length; i++) d[i] = 1 / (1 + Math.exp(-x.data[i])); out = { dims: x.dims, data: d }; break; }
        case 'Add': { const x = get(a); const y = get(b); const d = new Float32Array(x.data.length); for (let i = 0; i < d.length; i++) d[i] = x.data[i] + y.data[i]; out = { dims: x.dims, data: d }; break; }
        case 'MaxPool': out = maxPool(get(a), n.attrs); break;
        case 'Resize': out = resizeNearest(get(a), get(c).data); break;
        case 'Transpose': { // [C, H, W] → [H, W, C]
          const x = get(a);
          const [ch, h, w] = x.dims;
          const d = new Float32Array(x.data.length);
          for (let k = 0; k < ch; k++) for (let i = 0; i < h * w; i++) d[i * ch + k] = x.data[k * h * w + i];
          out = { dims: [h, w, ch], data: d };
          break;
        }
        case 'Reshape': { const x = get(a); out = { dims: [x.dims[0] * x.dims[1], x.dims[2]], data: x.data }; break; }
        default: throw new Error(`Opération ONNX non prise en charge : ${n.op}`);
      }
      t.set(n.outputs[0], out);
    }
    return Object.fromEntries(outputs.map((o) => [o, t.get(o)]));
  }

  /** rgb : Uint8Array (RVB entrelacé), width et height multiples de 32. Renvoie les visages triés par score. */
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
      const cols = width / stride;
      for (let i = 0; i < cls.length; i++) {
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (score < threshold) continue;
        const r = Math.floor(i / cols);
        const c = i % cols;
        const w = Math.exp(box[i * 4 + 2]) * stride;
        const h = Math.exp(box[i * 4 + 3]) * stride;
        found.push({ x: (c + box[i * 4]) * stride - w / 2, y: (r + box[i * 4 + 1]) * stride - h / 2, w, h, score });
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
