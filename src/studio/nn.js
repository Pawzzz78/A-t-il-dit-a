/**
 * Mini moteur de réseaux de neurones ONNX, en JavaScript + WebAssembly SIMD, sans aucune bibliothèque native.
 *
 * Il ne connaît que les opérations des deux modèles de visages utilisés (YuNet pour détecter, SFace pour reconnaître) :
 * Conv, BatchNormalization, Relu, PRelu, Sigmoid, Add, Sub, Mul, MaxPool, Resize « nearest », Transpose, Reshape, Flatten, Gemm,
 * Dropout. Les convolutions 1 × 1 et 3 × 3 par canal (l'essentiel du calcul) passent par des noyaux WebAssembly SIMD
 * (tools/kernels.wat) ; les autres convolutions sont ramenées à un produit matriciel (im2col) ou calculées en JavaScript.
 * Sans SIMD (NN_WASM=off, ou moteur trop ancien), tout est calculé en JavaScript : plus lent, même résultat.
 *
 * Les tenseurs n'ont pas de dimension de lot : [C, H, W] pour une image, [1, N] pour un vecteur.
 */
import { readFileSync } from 'node:fs';
import { KERNELS_WASM } from './kernels-wasm.js';

// --- lecture du protobuf ONNX (seulement ce dont les réseaux ont besoin) -----------------------------------------------------

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
      } else if (type === 5) p += 4;
      else throw new Error('Modèle ONNX illisible.');
    },
  };
}

const packedVarints = (bytes) => {
  const r = reader(bytes);
  const out = [];
  while (!r.done) out.push(r.varint());
  return out;
};
const text = (bytes) => Buffer.from(bytes).toString();
/** Octets quelconques (éventuellement non alignés) → Float32Array. */
const floats = (bytes) => new Float32Array(new Uint8Array(bytes).buffer, 0, Math.floor(bytes.length / 4));

function parseTensor(bytes) {
  const r = reader(bytes);
  const t = { name: '', dims: [], dtype: 1, data: null };
  let raw = null;
  while (!r.done) {
    const { no, type } = r.field();
    if (no === 1) type === 2 ? t.dims.push(...packedVarints(r.bytes())) : t.dims.push(r.varint());
    else if (no === 2) t.dtype = r.varint();
    else if (no === 4 && type === 2) t.data = floats(r.bytes());
    else if (no === 8) t.name = text(r.bytes());
    else if (no === 9) raw = r.bytes();
    else r.skip(type);
  }
  if (t.dtype === 1 && raw) t.data = floats(raw);
  return t;
}

function parseNode(bytes) {
  const r = reader(bytes);
  const n = { op: '', inputs: [], outputs: [], attrs: {} };
  while (!r.done) {
    const { no, type } = r.field();
    if (no === 1) n.inputs.push(text(r.bytes()));
    else if (no === 2) n.outputs.push(text(r.bytes()));
    else if (no === 4) n.op = text(r.bytes());
    else if (no === 5) {
      const a = reader(r.bytes());
      let name = '';
      let value;
      const ints = [];
      while (!a.done) {
        const f = a.field();
        if (f.no === 1) name = text(a.bytes());
        else if (f.no === 2) value = a.fixed32();
        else if (f.no === 3) value = a.varint();
        else if (f.no === 4) value = text(a.bytes());
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
  const inputs = [];
  const outputs = [];
  const names = (bytes, into) => {
    const v = reader(bytes);
    while (!v.done) {
      const f = v.field();
      if (f.no === 1) into.push(text(v.bytes()));
      else v.skip(f.type);
    }
  };
  while (!g.done) {
    const { no, type } = g.field();
    if (no === 1) nodes.push(parseNode(g.bytes()));
    else if (no === 5) {
      const t = parseTensor(g.bytes());
      init.set(t.name, t);
    } else if (no === 11) names(g.bytes(), inputs);
    else if (no === 12) names(g.bytes(), outputs);
    else g.skip(type);
  }
  return { nodes, init, inputs: inputs.filter((n) => !init.has(n)), outputs };
}

// --- mémoire WebAssembly ----------------------------------------------------------------------------------------------------

let wasmModule;
const simdOk = () => {
  if (process.env.NN_WASM === 'off') return false;
  try {
    wasmModule ??= new WebAssembly.Module(Buffer.from(KERNELS_WASM, 'base64'));
    return true;
  } catch {
    return false;
  }
};

class Wasm {
  constructor() {
    this.instance = new WebAssembly.Instance(wasmModule, {});
    this.exports = this.instance.exports;
    this.memory = this.exports.memory;
    this.top = 64; // octets déjà réservés (poids des réseaux) ; l'adresse 0 reste libre
    this.scratchBase = 0;
  }
  ensure(bytes) {
    const need = Math.ceil(bytes / 65536);
    const have = this.memory.buffer.byteLength / 65536;
    if (need > have) this.memory.grow(need - have);
  }
  /** Réserve de façon permanente de la place pour `data` (flottants) et l'y copie ; renvoie l'adresse en octets. */
  keep(data) {
    const ptr = this.top;
    this.top = ptr + Math.ceil((data.length * 4) / 16) * 16;
    this.ensure(this.top);
    new Float32Array(this.memory.buffer).set(data, ptr / 4);
    return ptr;
  }
  f32() {
    return new Float32Array(this.memory.buffer);
  }
}

// --- opérations en JavaScript (référence et repli) --------------------------------------------------------------------------

/** Convolution générale (groupes compris) ; x : [C, H, W]. */
function convJS(x, w, b, attrs) {
  const [, h, wd] = x.dims;
  const [cout, cinPerGroup, kh, kw] = w.dims;
  const group = attrs.group ?? 1;
  const [sy, sx] = attrs.strides ?? [1, 1];
  const [pt, pl] = attrs.pads ?? [0, 0, 0, 0];
  const oh = Math.floor((h + 2 * pt - kh) / sy) + 1;
  const ow = Math.floor((wd + 2 * pl - kw) / sx) + 1;
  const y = new Float32Array(cout * oh * ow);
  const outPerGroup = cout / group;
  const xd = x.data;
  const wdta = w.data;
  const plane = h * wd;
  for (let oc = 0; oc < cout; oc++) {
    const g = Math.floor(oc / outPerGroup);
    const yo = oc * oh * ow;
    if (b) y.fill(b[oc], yo, yo + oh * ow);
    for (let icg = 0; icg < cinPerGroup; icg++) {
      const xi = (g * cinPerGroup + icg) * plane;
      const wi = (oc * cinPerGroup + icg) * kh * kw;
      for (let ky = 0; ky < kh; ky++) {
        for (let kx = 0; kx < kw; kx++) {
          const wv = wdta[wi + ky * kw + kx];
          if (wv === 0) continue;
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

/** Indice du canal de chaque valeur d'un tenseur [C, H, W] ou [1, N]. */
const channelOf = (dims) => (dims.length === 3 ? (i) => Math.floor(i / (dims[1] * dims[2])) : (i) => i % dims[dims.length - 1]);

// --- compilation du réseau --------------------------------------------------------------------------------------------------

/** Chargement d'un modèle : { run(feeds), outputs }. `feeds` : { nom: { dims, data } } ; renvoie { nom: { dims, data } }. */
export function loadModel(file) {
  const { nodes, init, inputs, outputs } = parseOnnx(new Uint8Array(readFileSync(file)));
  const wasm = simdOk() ? new Wasm() : null;

  // Conv suivie d'une BatchNormalization à usage unique : la normalisation est repliée dans les poids
  const uses = new Map();
  for (const n of nodes) for (const i of n.inputs) uses.set(i, (uses.get(i) ?? 0) + 1);
  for (const o of outputs) uses.set(o, (uses.get(o) ?? 0) + 1);
  const steps = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const next = nodes[i + 1];
    // PRelu qui suit une convolution (éventuellement normalisée) et n'a pas d'autre usage : appliqué dans la même étape
    const prelu = (idx, name) => {
      const pn = nodes[idx];
      if (pn?.op === 'PRelu' && pn.inputs[0] === name && uses.get(name) === 1) return { slope: init.get(pn.inputs[1]).data, out: pn.outputs[0], skip: 1 };
      return null;
    };
    if (n.op === 'Conv' && next?.op === 'BatchNormalization' && next.inputs[0] === n.outputs[0] && uses.get(n.outputs[0]) === 1) {
      const [, gamma, beta, mean, vari] = next.inputs.map((k) => init.get(k));
      const eps = next.attrs.epsilon ?? 1e-5;
      const w = init.get(n.inputs[1]);
      const cout = w.dims[0];
      const per = w.data.length / cout;
      const wf = new Float32Array(w.data.length);
      const bf = new Float32Array(cout);
      const b0 = n.inputs[2] ? init.get(n.inputs[2]).data : null;
      for (let c = 0; c < cout; c++) {
        const s = gamma.data[c] / Math.sqrt(vari.data[c] + eps);
        for (let k = 0; k < per; k++) wf[c * per + k] = w.data[c * per + k] * s;
        bf[c] = ((b0 ? b0[c] : 0) - mean.data[c]) * s + beta.data[c];
      }
      const pr = prelu(i + 2, next.outputs[0]);
      steps.push(convStep({ ...n, outputs: [pr ? pr.out : next.outputs[0]] }, { dims: w.dims, data: wf }, bf, wasm, pr?.slope ?? null));
      i += pr ? 2 : 1;
    } else if (n.op === 'Conv') {
      const w = init.get(n.inputs[1]);
      const pr = prelu(i + 1, n.outputs[0]);
      steps.push(convStep({ ...n, outputs: [pr ? pr.out : n.outputs[0]] }, w, n.inputs[2] ? init.get(n.inputs[2]).data : null, wasm, pr?.slope ?? null));
      if (pr) i++;
    } else if (n.op === 'Gemm' && wasm && init.get(n.inputs[1]).dims[1] % 4 === 0) steps.push(gemmStep(n, init, wasm));
    else steps.push(opStep(n, init));
  }
  if (wasm) wasm.scratchBase = Math.ceil(wasm.top / 64) * 64;

  function run(feeds) {
    const t = new Map(Object.entries(feeds));
    for (const s of steps) t.set(s.out, s.fn(t));
    return Object.fromEntries(outputs.map((o) => [o, t.get(o)]));
  }
  return { run, outputs, inputs };
}

function convStep(n, w, bias, wasm, prelu = null) {
  const [cout, cinPerGroup, kh, kw] = w.dims;
  const attrs = n.attrs;
  const group = attrs.group ?? 1;
  const [sy, sx] = attrs.strides ?? [1, 1];
  const [pt, pl] = attrs.pads ?? [0, 0, 0, 0];
  const out = n.outputs[0];
  const input = n.inputs[0];
  const slopeFull = prelu ? (prelu.length === cout ? prelu : new Float32Array(cout).fill(prelu[0])) : null;
  const slopePtr = wasm && slopeFull ? wasm.keep(Float32Array.from([...slopeFull, 0, 0, 0, 0].slice(0, Math.ceil(cout / 4) * 4))) : 0;
  const pointwise = kh === 1 && kw === 1 && sy === 1 && sx === 1 && pt === 0 && pl === 0 && group === 1;
  const depthwise = kh === 3 && kw === 3 && sy === sx && (sy === 1 || sy === 2) && pt === 1 && pl === 1 && group === cout && cinPerGroup === 1;

  if (wasm && (pointwise || (group === 1 && !depthwise))) {
    // produit matriciel : [cout × (cin·kh·kw)] · [(cin·kh·kw) × pixels], le cas général passe d'abord par im2col
    const k = cinPerGroup * kh * kw;
    const coutP = Math.ceil(cout / 4) * 4;
    const wp = new Float32Array(coutP * k);
    wp.set(w.data);
    const bp = new Float32Array(coutP);
    if (bias) bp.set(bias);
    const wPtr = wasm.keep(wp);
    const bPtr = wasm.keep(bp);
    return {
      out,
      fn: (t) => {
        const x = t.get(input);
        const [cin, h, wd] = x.dims;
        const oh = pointwise ? h : Math.floor((h + 2 * pt - kh) / sy) + 1;
        const ow = pointwise ? wd : Math.floor((wd + 2 * pl - kw) / sx) + 1;
        const plane = oh * ow;
        const planeP = Math.ceil(plane / 8) * 8; // le noyau traite 8 pixels à la fois
        const xPtr = wasm.scratchBase;
        const yPtr = xPtr + k * planeP * 4;
        wasm.ensure(yPtr + coutP * planeP * 4);
        const f = wasm.f32();
        const xo = xPtr / 4;
        if (pointwise) {
          if (planeP === plane) f.set(x.data, xo);
          else for (let c = 0; c < cin; c++) f.set(x.data.subarray(c * plane, (c + 1) * plane), xo + c * planeP);
        } else {
          // im2col : une ligne par (canal, ky, kx), une colonne par pixel de sortie
          const xd = x.data;
          let row = 0;
          for (let c = 0; c < cin; c++) {
            for (let ky = 0; ky < kh; ky++) {
              for (let kx = 0; kx < kw; kx++, row++) {
                const base = xo + row * planeP;
                for (let oy = 0; oy < oh; oy++) {
                  const iy = oy * sy - pt + ky;
                  for (let ox = 0; ox < ow; ox++) {
                    const ix = ox * sx - pl + kx;
                    f[base + oy * ow + ox] = iy < 0 || iy >= h || ix < 0 || ix >= wd ? 0 : xd[c * h * wd + iy * wd + ix];
                  }
                }
              }
            }
          }
        }
        wasm.exports.pw(xPtr, wPtr, bPtr, yPtr, k, coutP, planeP);
        if (slopeFull) wasm.exports.prelu(yPtr, slopePtr, cout, planeP);
        const g = wasm.f32();
        const y = new Float32Array(cout * plane);
        const yo = yPtr / 4;
        if (planeP === plane) y.set(g.subarray(yo, yo + cout * plane));
        else for (let c = 0; c < cout; c++) y.set(g.subarray(yo + c * planeP, yo + c * planeP + plane), c * plane);
        return { dims: [cout, oh, ow], data: y };
      },
    };
  }

  if (wasm && depthwise) {
    const kPtr = wasm.keep(w.data);
    const bPtr = wasm.keep(bias ?? new Float32Array(cout));
    return {
      out,
      fn: (t) => {
        const x = t.get(input);
        const [ch, h, wd] = x.dims;
        const ow4 = Math.ceil(wd / 4) * 4;
        const pw = ow4 + 4; // ≥ ow4 + 2 : les chargements de 4 valeurs ne sortent jamais du plan
        const inPtr = wasm.scratchBase;
        const outPtr = inPtr + ch * (h + 2) * pw * 4;
        wasm.ensure(outPtr + ch * h * ow4 * 4);
        const f = wasm.f32();
        const io = inPtr / 4;
        f.fill(0, io, io + ch * (h + 2) * pw);
        for (let c = 0; c < ch; c++) for (let r = 0; r < h; r++) f.set(x.data.subarray(c * h * wd + r * wd, c * h * wd + (r + 1) * wd), io + (c * (h + 2) + r + 1) * pw + 1);
        wasm.exports.dw(inPtr, kPtr, bPtr, outPtr, ch, h, pw, ow4);
        if (slopeFull) wasm.exports.prelu(outPtr, slopePtr, ch, h * ow4);
        const g = wasm.f32();
        const oo = outPtr / 4;
        // pas 2 : on calcule la convolution au pas 1 puis on garde un pixel sur deux (le centre du noyau tombe sur les mêmes pixels)
        const oh = sy === 1 ? h : Math.floor((h - 1) / 2) + 1;
        const ow = sy === 1 ? wd : Math.floor((wd - 1) / 2) + 1;
        const y = new Float32Array(ch * oh * ow);
        for (let c = 0; c < ch; c++) {
          for (let r = 0; r < oh; r++) {
            const src = oo + (c * h + r * sy) * ow4;
            if (sy === 1) y.set(g.subarray(src, src + wd), (c * oh + r) * ow);
            else for (let q = 0; q < ow; q++) y[(c * oh + r) * ow + q] = g[src + q * 2];
          }
        }
        return { dims: [ch, oh, ow], data: y };
      },
    };
  }

  return {
    out,
    fn: (t) => {
      const y = convJS(t.get(input), w, bias, attrs);
      if (slopeFull) {
        const per = y.dims[1] * y.dims[2];
        for (let i = 0; i < y.data.length; i++) if (y.data[i] < 0) y.data[i] *= slopeFull[Math.floor(i / per)];
      }
      return y;
    },
  };
}

/** Gemm (A · Bᵀ + C avec A : [1, K]) par le noyau WebAssembly : les poids restent en mémoire du module. */
function gemmStep(n, init, wasm) {
  const w = init.get(n.inputs[1]);
  const [rows, k] = w.dims;
  const wPtr = wasm.keep(w.data);
  const bPtr = wasm.keep(n.inputs[2] ? init.get(n.inputs[2]).data : new Float32Array(rows));
  const input = n.inputs[0];
  return {
    out: n.outputs[0],
    fn: (t) => {
      const x = t.get(input).data;
      const xPtr = wasm.scratchBase;
      const yPtr = xPtr + k * 4;
      wasm.ensure(yPtr + rows * 4);
      wasm.f32().set(x, xPtr / 4);
      wasm.exports.gemv(xPtr, wPtr, bPtr, yPtr, k, rows);
      return { dims: [1, rows], data: wasm.f32().slice(yPtr / 4, yPtr / 4 + rows) };
    },
  };
}

function opStep(n, init) {
  const out = n.outputs[0];
  const get = (t, name) => t.get(name) ?? init.get(name);
  const [a, b, c] = n.inputs;
  const elementwise = (fn) => (t) => {
    const x = get(t, a);
    const y = get(t, b);
    const d = new Float32Array(x.data.length);
    const single = y.data.length === 1;
    for (let i = 0; i < d.length; i++) d[i] = fn(x.data[i], single ? y.data[0] : y.data[i]);
    return { dims: x.dims, data: d };
  };
  switch (n.op) {
    case 'Relu':
      return { out, fn: (t) => { const x = get(t, a); const d = new Float32Array(x.data.length); for (let i = 0; i < d.length; i++) d[i] = x.data[i] > 0 ? x.data[i] : 0; return { dims: x.dims, data: d }; } };
    case 'Sigmoid':
      return { out, fn: (t) => { const x = get(t, a); const d = new Float32Array(x.data.length); for (let i = 0; i < d.length; i++) d[i] = 1 / (1 + Math.exp(-x.data[i])); return { dims: x.dims, data: d }; } };
    case 'PRelu':
      return { out, fn: (t) => {
        const x = get(t, a);
        const slope = get(t, b).data;
        const d = new Float32Array(x.data.length);
        const per = x.dims.length === 3 ? x.dims[1] * x.dims[2] : 1; // valeurs par canal
        for (let i = 0; i < d.length; ) {
          const s = slope.length === 1 ? slope[0] : slope[Math.floor(i / per) % slope.length];
          for (const end = Math.min(d.length, i + per); i < end; i++) d[i] = x.data[i] > 0 ? x.data[i] : x.data[i] * s;
        }
        return { dims: x.dims, data: d };
      } };
    case 'Add': return { out, fn: elementwise((p, q) => p + q) };
    case 'Sub': return { out, fn: elementwise((p, q) => p - q) };
    case 'Mul': return { out, fn: elementwise((p, q) => p * q) };
    case 'MaxPool': return { out, fn: (t) => maxPool(get(t, a), n.attrs) };
    case 'Resize': return { out, fn: (t) => resizeNearest(get(t, a), get(t, c).data) };
    case 'Transpose': // [C, H, W] → [H, W, C]
      return { out, fn: (t) => {
        const x = get(t, a);
        const [ch, h, w] = x.dims;
        const d = new Float32Array(x.data.length);
        for (let k = 0; k < ch; k++) for (let i = 0; i < h * w; i++) d[i * ch + k] = x.data[k * h * w + i];
        return { dims: [h, w, ch], data: d };
      } };
    case 'Reshape': // têtes de YuNet : [H, W, C] → [H·W, C] (le fichier fixe 640 × 640, ignoré pour accepter d'autres définitions)
      return { out, fn: (t) => { const x = get(t, a); return { dims: [x.dims[0] * x.dims[1], x.dims[2]], data: x.data }; } };
    case 'Flatten': return { out, fn: (t) => { const x = get(t, a); return { dims: [1, x.data.length], data: x.data }; } };
    case 'Dropout': return { out, fn: (t) => get(t, a) };
    case 'BatchNormalization': {
      const [, gamma, beta, mean, vari] = n.inputs.map((k) => init.get(k));
      const eps = n.attrs.epsilon ?? 1e-5;
      return { out, fn: (t) => {
        const x = get(t, a);
        const chan = channelOf(x.dims);
        const d = new Float32Array(x.data.length);
        for (let i = 0; i < d.length; i++) {
          const ch = chan(i);
          d[i] = ((x.data[i] - mean.data[ch]) * gamma.data[ch]) / Math.sqrt(vari.data[ch] + eps) + beta.data[ch];
        }
        return { dims: x.dims, data: d };
      } };
    }
    case 'Gemm': // Y = A · Bᵀ + C (A : [1, K], B : [N, K])
      return { out, fn: (t) => {
        const x = get(t, a).data;
        const w = get(t, b);
        const bias = c ? get(t, c).data : null;
        const [rows, k] = w.dims;
        const y = new Float32Array(rows);
        for (let r = 0; r < rows; r++) {
          let s0 = 0;
          let s1 = 0;
          let i = 0;
          const o = r * k;
          for (; i + 1 < k; i += 2) {
            s0 += x[i] * w.data[o + i];
            s1 += x[i + 1] * w.data[o + i + 1];
          }
          if (i < k) s0 += x[i] * w.data[o + i];
          y[r] = s0 + s1 + (bias ? bias[r] : 0);
        }
        return { dims: [1, rows], data: y };
      } };
    default:
      throw new Error(`Opération ONNX non prise en charge : ${n.op}`);
  }
}
