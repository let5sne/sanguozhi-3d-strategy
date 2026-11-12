/**
 * 轻量确定性噪声库（无外部依赖）
 * 用于地形高度场、地貌斑驳、植被散布、边界扰动。
 * 所有函数都是纯函数，同一 seed 在桌面 / 移动端结果完全一致。
 */

/** 2D 整数哈希 -> [0,1) */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 平滑插值 */
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

/** 二维 value noise，返回 [0,1] */
export function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const tx = smooth(x - xi), ty = smooth(y - yi);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

/** 分形布朗运动：多倍频叠加，模拟自然地貌的粗糙层次 */
export function fbm(x, y, octaves = 6, seed = 0, lacunarity = 2.03, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + i * 131);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** 山脊噪声：|2n-1| 反转后取幂，用于形成连绵山脉的锐利脊线 */
export function ridged(x, y, octaves = 5, seed = 0) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(valueNoise(x * freq, y * freq, seed + i * 97) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return sum / norm;
}

/** 二维平滑随机（用于散布位置抖动） */
export function rand2(i, j, salt = 0) {
  return hash2(i * 7919 + 13, j * 104729 + 7, salt);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
export const mix = lerp;
