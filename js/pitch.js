// pitch.js — マイク入力からのリアルタイムピッチ検出（YIN アルゴリズム）
import { freqToMidi, clamp } from './util.js';

/**
 * YIN 方式で基本周期を推定する
 * @param {Float32Array} buf  時系列サンプル（先頭から使う）
 * @param {number} sampleRate
 * @returns {number|null} 周波数 (Hz)、検出できなければ null
 */
export function detectFrequency(buf, sampleRate) {
  const W = Math.min(buf.length, 1024);        // 解析窓
  const half = W >> 1;
  const tauMin = Math.max(2, Math.floor(sampleRate / 1200));   // ≒1200Hz まで
  const tauMax = Math.min(W - 1, Math.floor(sampleRate / 60)); // ≒60Hz まで

  if (buf.length < tauMax + half + 1) {
    // バッファ不足時は窓を縮める
    return detectSmall(buf, sampleRate);
  }

  // 1. 差分関数
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }

  // 2. 累積平均正規化差分関数
  const cmndf = new Float32Array(tauMax + 1);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmndf[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // 3. 絶対閾値で最初の谷を探す
  const threshold = 0.15;
  let tauEstimate = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
      tauEstimate = tau;
      break;
    }
  }
  if (tauEstimate < 0) {
    // 閾値を超えなければ最小値を採用（弱い信号でも拾えるように）
    let minVal = 0.35, minTau = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (cmndf[tau] < minVal) { minVal = cmndf[tau]; minTau = tau; }
    }
    if (minTau < 0) return null;
    tauEstimate = minTau;
  }

  // 4. 放物線補間で小数精度へ
  let betterTau = tauEstimate;
  if (tauEstimate > tauMin && tauEstimate < tauMax) {
    const y0 = cmndf[tauEstimate - 1];
    const y1 = cmndf[tauEstimate];
    const y2 = cmndf[tauEstimate + 1];
    const denom = 2 * (2 * y1 - y2 - y0);
    if (Math.abs(denom) > 1e-12) betterTau = tauEstimate + (y2 - y0) / denom;
  }

  const freq = sampleRate / betterTau;
  if (!isFinite(freq) || freq < 50 || freq > 1400) return null;
  return freq;
}

function detectSmall(buf, sampleRate) {
  const W = buf.length;
  const tauMax = Math.min(W - 2, Math.floor(sampleRate / 60));
  const half = W >> 1;
  if (tauMax < 4) return null;
  const d = new Float32Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmndf = new Float32Array(tauMax + 1);
  cmndf[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    cmndf[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }
  let minVal = 0.2, minTau = -1;
  for (let tau = 2; tau <= tauMax; tau++) {
    if (cmndf[tau] < minVal) { minVal = cmndf[tau]; minTau = tau; }
  }
  if (minTau < 0) return null;
  const freq = sampleRate / minTau;
  return isFinite(freq) && freq > 50 && freq < 1400 ? freq : null;
}

/**
 * AnalyserNode からピッチ（MIDIノート番号, 小数）と音量を求める
 * @returns {{midi:number|null, level:number, freq:number|null}}
 */
const _timeBuf = new Float32Array(2048);
export function analyzePitch(analyser) {
  if (!analyser) return { midi: null, level: 0, freq: null };
  analyser.getFloatTimeDomainData(_timeBuf);

  // RMS レベル（無音判定 / メーター用）
  let sum = 0;
  for (let i = 0; i < _timeBuf.length; i++) sum += _timeBuf[i] * _timeBuf[i];
  const level = Math.sqrt(sum / _timeBuf.length);

  if (level < 0.012) return { midi: null, level, freq: null }; // 無音は検出せず

  const freq = detectFrequency(_timeBuf, analyser.context.sampleRate);
  if (!freq) return { midi: null, level, freq: null };
  const midi = clamp(freqToMidi(freq), 24, 96);
  return { midi, level, freq };
}

/** しきい値（ノートと比較してこの半音差以内なら「合っている」） */
export const TOLERANCE = {
  easy: { perfect: 1.0, good: 2.0 },
  normal: { perfect: 0.55, good: 1.5 },
  hard: { perfect: 0.3, good: 0.9 },
};
