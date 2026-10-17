// piano-roll.js — ピアノロール風タイムライン編集 UI
//   ・ノートの追加 / 移動 / 長さ変更 / 削除
//   ・スナップ（拍グリッド）付き
//   ・ホイール: 上下=時間スクロール / Shift=音域スクロール / Ctrl=ズーム
//
import { clamp, formatTime1 } from './util.js';

const RULER_H = 18;
const RESIZE_PX = 12;
const BLACK = [1, 3, 6, 8, 10];

export class PianoRoll {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} ctl
   *   getView()          → { scrollT, pps, gutter, pxPerMidi, topMidi, snap }
   *   getNotes()         → [{id, midi, start, dur}]
   *   getSelected() / setSelected(note)
   *   onSeek(t) / onChange() / onCreated(note)
   *   snap(t) / getTime() / getBpm()
   */
  constructor(canvas, ctl) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctl = ctl;
    this.mode = null;
    this.drag = null;
    this.follow = false;
    this._bound = true;

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => { if (!this.mode) this._hover(e); });
    canvas.addEventListener('pointerleave', () => { if (!this.mode) this.canvas.style.cursor = ''; });
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('contextmenu', (e) => this._ctxmenu(e));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    window.addEventListener('resize', () => this.draw());
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth || c.parentElement.clientWidth || 600;
    const h = c.clientHeight || 400;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.w = w;
    this.h = h;
    this.dpr = dpr;
  }

  timeToX(t) { const v = this.ctl.getView(); return v.gutter + (t - v.scrollT) * v.pps; }
  xToTime(x) { const v = this.ctl.getView(); return v.scrollT + (x - v.gutter) / v.pps; }
  midiToY(m) { const v = this.ctl.getView(); return RULER_H + (v.topMidi - m) * v.pxPerMidi; }
  yToMidi(y) { const v = this.ctl.getView(); return Math.round(v.topMidi - (y - RULER_H) / v.pxPerMidi); }

  // ------------------------------------------------------------------
  //  描画
  // ------------------------------------------------------------------
  draw() {
    this.resize();
    const { w, h } = this;
    const ctx = this.ctx;
    const v = this.ctl.getView();
    const notes = this.ctl.getNotes();
    const selected = this.ctl.getSelected();
    const bpm = this.ctl.getBpm() || 120;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // --- グリッド ---
    const minMidi = v.topMidi - Math.floor((h - RULER_H) / v.pxPerMidi);
    for (let m = v.topMidi; m >= minMidi - 1; m--) {
      const y = this.midiToY(m);
      const black = BLACK.includes(((m % 12) + 12) % 12);
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.fillStyle = black ? '#0e1424' : '#141b2e';
      ctx.fillRect(v.gutter, y, w - v.gutter, v.pxPerMidi);
      ctx.strokeStyle = isC ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath();
      ctx.moveTo(v.gutter, y + 0.5);
      ctx.lineTo(w, y + 0.5);
      ctx.stroke();
    }

    // 拍 / 小節線
    const beat = 60 / bpm;
    const t0 = v.scrollT;
    const t1 = v.scrollT + (w - v.gutter) / v.pps;
    const startBeat = Math.floor(t0 / beat);
    const endBeat = Math.ceil(t1 / beat);
    for (let b = startBeat; b <= endBeat; b++) {
      const t = b * beat;
      const x = this.timeToX(t) + 0.5;
      const isBar = ((b % 4) + 4) % 4 === 0;
      ctx.strokeStyle = isBar ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, RULER_H);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    // --- ノート ---
    for (const n of notes) {
      if (n.start + n.dur < t0 || n.start > t1) continue;
      if (n.midi > v.topMidi + 1 || n.midi < minMidi - 1) continue;
      const x = this.timeToX(n.start);
      const bw = Math.max(3, n.dur * v.pps);
      const y = this.midiToY(n.midi);
      const bh = v.pxPerMidi - 2;
      const hue = 205 + (((n.midi % 12) + 12) % 12) * 6;

      roundRect(ctx, x, y + 1, bw, bh, 3);
      const g = ctx.createLinearGradient(0, y, 0, y + bh);
      g.addColorStop(0, `hsl(${hue} 85% 62%)`);
      g.addColorStop(1, `hsl(${hue} 75% 45%)`);
      ctx.fillStyle = g;
      ctx.fill();

      if (selected && selected.id === n.id) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
        // リサイズハンドル
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(x + bw - 3, y + 3, 3, bh - 4);
      }
    }

    // --- グリッド左の鍵盤ラベル ---
    ctx.fillStyle = '#0a0e1a';
    ctx.fillRect(0, RULER_H, v.gutter, h - RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(v.gutter + 0.5, 0);
    ctx.lineTo(v.gutter + 0.5, h);
    ctx.stroke();

    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let m = v.topMidi; m >= minMidi - 1; m--) {
      const y = this.midiToY(m);
      const pc = ((m % 12) + 12) % 12;
      if (pc !== 0 && !BLACK.includes(pc)) continue;
      ctx.fillStyle = pc === 0 ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.35)';
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      ctx.fillText(`${names[pc]}${Math.floor(m / 12) - 1}`, v.gutter - 3, y + v.pxPerMidi / 2);
    }

    // --- ルーラ ---
    ctx.fillStyle = '#080c17';
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.moveTo(0, RULER_H + 0.5);
    ctx.lineTo(w, RULER_H + 0.5);
    ctx.stroke();

    const secStep = v.pps >= 200 ? 1 : v.pps >= 90 ? 5 : 10;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(t0 / secStep) * secStep; t <= t1; t += secStep) {
      const x = this.timeToX(t);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(formatTime1(t), x + 3, 4);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, RULER_H - 5);
      ctx.lineTo(x + 0.5, RULER_H);
      ctx.stroke();
    }

    // --- 再生位置 ---
    const time = this.ctl.getTime ? this.ctl.getTime() : 0;
    const px = this.timeToX(time);
    if (px >= 0 && px <= w) {
      ctx.strokeStyle = '#ff5d8f';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, h);
      ctx.stroke();
      ctx.fillStyle = '#ff5d8f';
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 5, 0);
      ctx.lineTo(px, 8);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
    }
  }

  /** 再生中にビューポートを追従 */
  autoFollow(time) {
    if (!this.follow) return;
    const v = this.ctl.getView();
    const x = this.timeToX(time);
    const limit = v.gutter + (this.w || 800) * 0.78;
    if (x > limit || x < v.gutter) {
      v.scrollT = Math.max(0, time - ((this.w || 800) - v.gutter) * 0.2 / v.pps);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  //  入力
  // ------------------------------------------------------------------
  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  _hitNote(x, y) {
    const v = this.ctl.getView();
    const notes = this.ctl.getNotes();
    const t = this.xToTime(x);
    const midi = this.yToMidi(y);
    let best = null;
    for (const n of notes) {
      if (n.midi !== midi) continue;
      if (t >= n.start - 0.02 && t <= n.start + n.dur + 0.02) {
        if (!best || Math.abs(n.start - t) < Math.abs(best.start - t)) best = n;
      }
    }
    return best;
  }

  /** ホバー中のカーソル表示（ノート本体=移動 / 右端=伸長） */
  _hover(e) {
    const { x, y } = this._local(e);
    if (y < RULER_H) { this.canvas.style.cursor = 'ew-resize'; return; }
    const hit = this._hitNote(x, y);
    if (!hit) { this.canvas.style.cursor = 'crosshair'; return; }
    const edgeX = this.timeToX(hit.start + hit.dur);
    this.canvas.style.cursor = (Math.abs(x - edgeX) <= RESIZE_PX || x > edgeX) ? 'ew-resize' : 'move';
  }

  _down(e) {
    const { x, y } = this._local(e);
    const v = this.ctl.getView();
    this.canvas.focus && this.canvas.focus();

    if (e.button === 2) return; // 右クリックは contextmenu 側

    // ルーラ → シーク
    if (y < RULER_H) {
      this.mode = 'scrub';
      this.ctl.onSeek(clamp(this.xToTime(x), 0, 1e9));
      e.preventDefault();
      return;
    }

    const t = clamp(this.ctl.snap(this.xToTime(x)), 0, 1e9);
    const midi = this.yToMidi(y);
    const hit = this._hitNote(x, y);

    if (hit) {
      const edgeX = this.timeToX(hit.start + hit.dur);
      const onEdge = e.shiftKey || Math.abs(x - edgeX) <= RESIZE_PX || x > edgeX;
      this.ctl.setSelected(hit);
      if (onEdge) {
        this.mode = 'resize';
        this.drag = { note: hit, startX: x, startDur: hit.dur };
      } else {
        this.mode = 'move';
        this.drag = { note: hit, grabT: this.xToTime(x) - hit.start, grabMidi: midi - hit.midi };
      }
      this.ctl.onChange();
      e.preventDefault();
      return;
    }

    // 新規作成
    const dur = v.snap > 0 ? (60 / (this.ctl.getBpm() || 120)) * v.snap : 0.5;
    const note = { id: `n${Date.now().toString(36)}${Math.floor(Math.random() * 999)}`, midi, start: t, dur: Math.max(0.05, dur) };
    this.ctl.getNotes().push(note);
    this.ctl.setSelected(note);
    this.mode = 'move';
    this.drag = { note, grabT: this.xToTime(x) - note.start, grabMidi: 0, created: true };
    this.ctl.onChange();
    e.preventDefault();
  }

  _move(e) {
    if (!this.mode || !this.drag) return;
    const { x, y } = this._local(e);
    const v = this.ctl.getView();

    if (this.mode === 'scrub') {
      this.ctl.onSeek(clamp(this.xToTime(x), 0, 1e9));
      return;
    }

    const n = this.drag.note;
    if (this.mode === 'move') {
      const t = this.xToTime(x) - this.drag.grabT;
      const midi = this.yToMidi(y) - this.drag.grabMidi;
      n.start = Math.max(0, this.ctl.snap(t));
      n.midi = clamp(midi, 0, 127);
      this.ctl.onChange();
    } else if (this.mode === 'resize') {
      const endT = this.xToTime(x);
      let dur = endT - n.start;
      const grid = v.snap > 0 ? (60 / (this.ctl.getBpm() || 120)) * v.snap : 0;
      if (grid > 0) dur = Math.round(dur / grid) * grid;
      n.dur = clamp(dur, grid > 0 ? grid : 0.05, 60);
      this.ctl.onChange();
    }
  }

  _up() {
    if (this.mode && this.drag) {
      this.drag = null;
      this.mode = null;
      this.ctl.onChange();
      if (this.ctl.onSelectChanged) this.ctl.onSelectChanged();
    }
    this.mode = null;
  }

  _ctxmenu(e) {
    e.preventDefault();
    const { x, y } = this._local(e);
    const hit = this._hitNote(x, y);
    if (hit) {
      const notes = this.ctl.getNotes();
      const i = notes.indexOf(hit);
      if (i >= 0) notes.splice(i, 1);
      if (this.ctl.getSelected() === hit) this.ctl.setSelected(null);
      this.ctl.onChange();
      if (this.ctl.onSelectChanged) this.ctl.onSelectChanged();
    }
  }

  _wheel(e) {
    e.preventDefault();
    const v = this.ctl.getView();
    const { x, y } = this._local(e);
    const delta = e.deltaY + (e.deltaX || 0);

    if (e.ctrlKey || e.metaKey) {
      // ズーム（カーソル下の時刻を固定）
      const tUnder = this.xToTime(x);
      const factor = Math.pow(1.0015, -delta);
      v.pps = clamp(v.pps * factor, 15, 600);
      v.scrollT = Math.max(0, tUnder - (x - v.gutter) / v.pps);
    } else if (e.shiftKey) {
      v.topMidi = clamp(Math.round(v.topMidi + delta / v.pxPerMidi), 24, 108);
    } else {
      v.scrollT = Math.max(0, v.scrollT + delta / v.pps);
    }
    this.draw();
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
