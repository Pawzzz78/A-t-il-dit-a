// Assemble tools/kernels.wat en WebAssembly (SIMD) et l'écrit dans src/studio/kernels-wasm.js (octets en base64).
// Usage : npm install --no-save wabt && node tools/build_kernels.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import wabt from 'wabt';

const w = await wabt();
const mod = w.parseWat('kernels.wat', readFileSync(new URL('./kernels.wat', import.meta.url), 'utf8'), { simd: true });
const { buffer } = mod.toBinary({});
const b64 = Buffer.from(buffer).toString('base64');
writeFileSync(
  new URL('../src/studio/kernels-wasm.js', import.meta.url),
  `// Généré par tools/build_kernels.mjs à partir de tools/kernels.wat : ne pas modifier à la main.\nexport const KERNELS_WASM = '${b64}';\n`,
);
console.log(`kernels-wasm.js : ${buffer.length} octets`);
