// util.js — 共通ユーティリティ
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 秒 → "m:ss" */
export function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** 秒 → "m:ss.d" */
export function formatTime1(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

/** MIDIノート番号 → 周波数 */
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** 周波数 → MIDIノート番号(小数) */
export const freqToMidi = (f) => 69 + 12 * Math.log2(f / 440);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(m) {
  const i = Math.round(m);
  return NOTE_NAMES[((i % 12) + 12) % 12] + (Math.floor(i / 12) - 1);
}

/** 半音のずれを「◯キー下/上」表記へ */
export function keyLabel(semi) {
  const n = Math.round(semi);
  if (n === 0) return '元のキー';
  return n > 0 ? `+${n}` : `${n}`;
}

/** 数値を丸めて桁数指定 */
export const round = (v, d = 2) => {
  const p = Math.pow(10, d);
  return Math.round(v * p) / p;
};

/** ファイルをローカルへダウンロード */
export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** ファイル選択ダイアログを Promise で開く */
export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    inp.style.display = 'none';
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); inp.remove(); };
    inp.onchange = () => finish(multiple ? Array.from(inp.files) : (inp.files[0] || null));
    inp.oncancel = () => finish(null);
    // キャンセル検出のフォールバック
    window.addEventListener('focus', () => setTimeout(() => { if (!done && !inp.files.length) finish(null); }, 500), { once: true });
    document.body.appendChild(inp);
    inp.click();
  });
}

/** トースト表示 */
let toastTimer = null;
export function toast(msg, type = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

/** 文字列/値を JSON として安全に保存 */
export function storeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota */ }
}
export function loadJSON(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch (e) { return fallback; }
}

/** 指定msだけ待つ */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** デバッグログ（?debug=1 のときだけ出力） */
const DEBUG = /[?&]debug=1/.test(location.search);
export function dlog(...args) { if (DEBUG) console.log('[ksg]', ...args); }
