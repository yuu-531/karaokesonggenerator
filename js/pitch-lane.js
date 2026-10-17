// pitch-lane.js — Canvas 上に流れる「音程バー」とユーザーの音程軌跡
import { clamp, midiToName } from './util.js';

const COLORS = {
  perfect: '#5be9b0',
  good: '#ffd166',
  miss: '#ff5d8f',
  pending: '#5f8fd8',
  active: '#ffffff',
  trail: '#8bf7ff',
  user: '#ff9be8',
};

export class PitchLane {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.notes = [];
    this.scorer = null;
    this.bpm = 120;
    this.duration = 0;
    this.pps = 96;              // 横方向: px / 秒
    this.laneLeft = 42;         // ノート名ラベル帯
    this.minMidi = 45;
    this.maxMidi = 84;
    this.dpr = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || c.parentElement.clientWidth || 600;
    const h = Number(c.getAttribute('height')) || 168;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
  }

  setData(notes, opt = {}) {
    this.notes = (notes || []).slice().sort((a, b) => a.start - b.start);
    this.bpm = opt.bpm || this.bpm;
    this.duration = opt.duration || 0;
    if (this.notes.length) {
      const midis = this.notes.map((n) => n.midi);
      this.minMidi = Math.min(...midis) - 3;
      this.maxMidi = Math.max(...midis) + 3;
      if (this.maxMidi - this.minMidi < 12) {
        const mid = (this.maxMidi + this.minMidi) / 2;
        this.minMidi = Math.floor(mid - 7);
        this.maxMidi = Math.ceil(mid + 7);
      }
    } else {
      this.minMidi = 48;
      this.maxMidi = 84;
    }
  }

  yOf(midi) {
    const range = this.maxMidi - this.minMidi + 1;
    const usable = this.h - 8;
    return 4 + usable - ((midi - this.minMidi) / range) * usable;
  }

  /**
   * @param {number} time     曲内時刻
   * @param {Object} opt      { offset, detected:{midi,level}|null, micOn }
   */
  render(time, opt = {}) {
    const ctx = this.ctx;
    const { w, h } = this;
    if (!w || !h) this.resize();
    const offset = opt.offset || 0;
    const nowX = this.laneLeft + (w - this.laneLeft) * 0.3;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // --- 背景 ---
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#0b1020');
    bg.addColorStop(1, '#070a14');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const range = this.maxMidi - this.minMidi + 1;
    const px = (w - this.laneLeft) / range;

    // --- 半音グリッド ---
    ctx.lineWidth = 1;
    for (let m = this.minMidi; m <= this.maxMidi + 1; m++) {
      const y = this.yOf(m + 0.5);
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.strokeStyle = isC ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(this.laneLeft, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
      if (isC && px > 4) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(midiToName(m), 5, y - 0.5);
      }
    }

    // --- 拍グリッド ---
    const beat = 60 / Math.max(1, this.bpm);
    const tStart = time - nowX / this.pps;
    const tEnd = time + (w - nowX) / this.pps;
    if (this.bpm > 0) {
      let b = Math.floor(tStart / beat);
      for (; b * beat <= tEnd; b++) {
        const tb = b * beat;
        const x = nowX + (tb - time) * this.pps;
        const strong = b % 4 === 0;
        ctx.strokeStyle = strong ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
        ctx.stroke();
      }
    }

    // --- ラベル帯 ---
    ctx.fillStyle = 'rgba(5,8,16,0.85)';
    ctx.fillRect(0, 0, this.laneLeft, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(this.laneLeft + 0.5, 0);
    ctx.lineTo(this.laneLeft + 0.5, h);
    ctx.stroke();

    // --- 音程バー ---
    const states = this.scorer ? this.scorer.states : null;
    const notes = this.notes;
    if (!notes.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('メロディ MIDI がありません — 音程バーは表示されません', (w + this.laneLeft) / 2, h / 2);
    }

    let lo = 0, hi = notes.length - 1, from = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].start < tStart) { from = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    for (let i = Math.max(0, from); i < notes.length; i++) {
      const n = notes[i];
      if (n.start > tEnd) break;
      const x = nowX + (n.start - time) * this.pps;
      const bw = Math.max(3, n.dur * this.pps - 2);
      const midi = n.midi + offset;
      const yc = this.yOf(midi);
      const laneH = Math.max(6, ((this.h - 8) / range) * 0.86);
      const y = yc - laneH / 2;

      const active = n.start <= time && n.end > time;
      let fill = COLORS.pending;
      let alpha = 0.55;
      const st = states && states[i];
      if (st && st.judged) {
        fill = st.judgment === 'perfect' ? COLORS.perfect
          : st.judgment === 'good' ? COLORS.good : COLORS.miss;
        alpha = 0.92;
      } else if (active) {
        fill = COLORS.active;
        alpha = 1;
      }

      ctx.globalAlpha = alpha;
      roundRect(ctx, x, y, bw, laneH, Math.min(4, laneH / 2));
      ctx.fillStyle = fill;
      ctx.fill();
      if (active) {
        ctx.shadowColor = fill;
        ctx.shadowBlur = 14;
        ctx.fill();
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = 1;

      // 次の予定音の小見出し
      if (!active && n.start > time && n.start - time < 3 && bw > 16) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.round(midi)), x + bw / 2, yc);
      }
    }

    // --- ユーザーの音程ヒストリ（スコアラーが記録） ---
    if (this.scorer && this.scorer.trail.length) {
      const trail = this.scorer.trail;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = COLORS.trail;
      ctx.shadowColor = COLORS.trail;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      let started = false;
      for (let i = trail.length - 1; i >= 0; i--) {
        const p = trail[i];
        if (p.t < time - 4) break;
        if (p.midi == null) { started = false; continue; }
        const x = nowX + (p.t - time) * this.pps;
        const y = this.yOf(p.midi + offset);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // --- 現在の検出ピッチ ---
    if (opt.detected && opt.detected.midi != null) {
      const y = this.yOf(opt.detected.midi + offset);
      const r = 4 + clamp(opt.detected.level * 60, 0, 7);
      ctx.fillStyle = COLORS.user;
      ctx.shadowColor = COLORS.user;
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(nowX, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // --- NOW 線 ---
    const lg = ctx.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, 'rgba(255,255,255,0.85)');
    lg.addColorStop(1, 'rgba(120,190,255,0.55)');
    ctx.strokeStyle = lg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    ctx.fillStyle = 'rgba(120,190,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(nowX - 5, 0);
    ctx.lineTo(nowX + 5, 0);
    ctx.lineTo(nowX, 8);
    ctx.closePath();
    ctx.fill();

    // --- マイク未接続の警告 ---
    if (opt.micOn === false) {
      ctx.fillStyle = 'rgba(255,120,140,0.9)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('MIC OFF — 進行中は採点されません', w - 8, 8);
    }
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
