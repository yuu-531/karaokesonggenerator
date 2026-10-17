// waveform.js — オーディオ波形ビジュアライザー
import { clamp } from './util.js';

export class Waveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.buffer = null;
    this.peaks = null;     // { min:Float32Array, max:Float32Array, n:number }
    this._w = 0;
    this._h = 0;
    window.addEventListener('resize', () => this.draw());
  }

  setBuffer(buffer) {
    this.buffer = buffer;
    this.peaks = buffer ? computePeaks(buffer, 12000) : null;
    this.draw();
  }

  draw(viewArg) {
    if (viewArg) this._lastView = viewArg;
    const v = viewArg || this._lastView;
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || c.parentElement.clientWidth || 600;
    const h = Number(c.getAttribute('height')) || 92;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景
    ctx.fillStyle = '#0a0f1d';
    ctx.fillRect(0, 0, w, h);
    const gutter = v ? v.gutter : 34;
    ctx.fillStyle = '#070b15';
    ctx.fillRect(0, 0, gutter, h);

    if (!this.peaks || !v) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('音源を読み込むと波形が表示されます', w / 2, h / 2);
      return;
    }

    const view = v;
    const { min, max, n } = this.peaks;
    const dur = this.buffer.duration;
    const mid = h / 2;
    const amp = (h / 2) - 6;

    // グリッド（秒）
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    const secStep = view.pps >= 120 ? 1 : view.pps >= 60 ? 5 : 10;
    const t0 = view.scrollT;
    const t1 = view.scrollT + (w - gutter) / view.pps;
    for (let t = Math.floor(t0 / secStep) * secStep; t <= t1; t += secStep) {
      const x = gutter + (t - view.scrollT) * view.pps + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // 波形
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#4fd1c5');
    grad.addColorStop(0.5, '#7aa2ff');
    grad.addColorStop(1, '#4fd1c5');
    ctx.fillStyle = grad;

    const startIdx = (t0 / dur) * n;
    const endIdx = (t1 / dur) * n;
    for (let x = gutter; x < w; x++) {
      const t = view.scrollT + (x - gutter) / view.pps;
      if (t < 0 || t > dur) continue;
      const fi = (t / dur) * n;
      const i0 = clamp(Math.floor(fi), 0, n - 1);
      const i1 = clamp(Math.ceil(fi), 0, n - 1);
      let lo = Math.min(min[i0], min[i1]);
      let hi = Math.max(max[i0], max[i1]);
      // 拡大中は範囲を広げて取りこぼしを防ぐ
      const span = Math.max(1, Math.floor((endIdx - startIdx) / Math.max(1, w - gutter)));
      if (span > 1) {
        for (let k = 1; k < span; k++) {
          const j = clamp(i0 + k, 0, n - 1);
          if (min[j] < lo) lo = min[j];
          if (max[j] > hi) hi = max[j];
        }
      }
      const y0 = mid - hi * amp;
      const y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }

    // 中央線
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.moveTo(gutter, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();
  }
}

/** 全サンプルを走査して buckets 個の min/max ピークを作る */
function computePeaks(buffer, buckets) {
  const n = Math.min(buckets, Math.max(1, Math.floor(buffer.duration * 100)));
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  min.fill(1); max.fill(-1);

  const chCount = buffer.numberOfChannels;
  const chans = [];
  for (let c = 0; c < chCount; c++) chans.push(buffer.getChannelData(c));
  const len = buffer.length;

  for (let i = 0; i < len; i++) {
    const b = Math.min(n - 1, ((i / len) * n) | 0);
    let v = 0;
    for (let c = 0; c < chCount; c++) v += chans[c][i];
    v /= chCount;
    if (v < min[b]) min[b] = v;
    if (v > max[b]) max[b] = v;
  }
  for (let b = 0; b < n; b++) {
    if (min[b] > max[b]) { min[b] = 0; max[b] = 0; }
  }
  return { min, max, n };
}
