// lyrics-view.js — 字幕表示と「歌詞ワイプ（カラー変化）」
//
//   文字ごとに start / end を持ち、
//     progress = (現在時刻 - start) / (end - start)
//   を毎フレーム CSS 変数 --p へ書き込むことで、
//   背景グラデーションを text-clip した文字が滑らかに色を変える。
//
import { clamp } from './util.js';

export class LyricsView {
  constructor(root) {
    this.root = root;
    this.items = [];      // { el, chars:[{el,s,e}], level:bool, start, end }
    this.current = -2;    // 未更新を表す初期値
    this.glow = true;
    this.textOnly = false; // タイミング無し → 全体を等分ワイプ
  }

  setGlow(on) { this.glow = !!on; this.root.classList.toggle('no-glow', !this.glow); }

  clear() {
    this.root.innerHTML = '';
    this.items = [];
    this.current = -2;
  }

  /**
   * @param {Object} lyrics  { lines: [{ start, end, text, syllables:[{text,start,end}] }] }
   * @param {number} duration 曲の長さ(秒) — タイミングが無い場合の等分に使用
   */
  setData(lyrics, duration = 0) {
    this.clear();
    const lines = (lyrics && lyrics.lines) || [];
    if (!lines.length) return;

    const hasTiming = lines.some((l) => (l.start > 0 || l.end > 0) || (l.syllables && l.syllables.length));

    // タイミングが丸ごと無い → 歌詞行を曲全体へ等分
    if (!hasTiming && duration > 0) {
      const step = duration / lines.length;
      lines.forEach((l, i) => { l.start = i * step; l.end = (i + 1) * step * 0.96; });
      this.textOnly = true;
    }

    lines.forEach((ln) => {
      const el = document.createElement('div');
      el.className = 'lyric-line';

      const chars = Array.from(ln.text || '');
      const charTimes = computeCharTimes(ln, chars);

      const charEls = [];
      chars.forEach((ch, i) => {
        const span = document.createElement('span');
        span.className = 'ch' + (ch === ' ' || ch === '　' ? ' sp' : '');
        span.textContent = ch === ' ' ? ' ' : ch;
        if (charTimes) {
          span.style.setProperty('--p', '0');
        }
        el.appendChild(span);
        charEls.push({ el: span, s: charTimes ? charTimes[i].s : 0, e: charTimes ? charTimes[i].e : 0 });
      });

      this.root.appendChild(el);
      this.items.push({
        el,
        chars: charEls,
        level: !charTimes,          // 文字単位タイミングが無ければ行全体ワイプ
        start: ln.start || 0,
        end: ln.end || 0,
        painted: null,
      });
    });

    this.current = -2;
    this._applyClasses(-1);   // 初期状態では全行を非表示にしておく
  }

  /** 毎フレーム呼び出す（requestAnimationFrame 内） */
  update(t) {
    if (!this.items.length) return;
    const idx = this._findLine(t);

    if (idx !== this.current) {
      this._applyClasses(idx);
      this.current = idx;
    }

    const it = this.items[idx < 0 ? 0 : idx];
    if (!it || idx < 0) return;

    if (it.level) {
      // 行全体でワイプ
      const p = it.end > it.start ? clamp((t - it.start) / (it.end - it.start), 0, 1) : (t >= it.start ? 1 : 0);
      setVar(it.el, p);
    } else {
      // 文字ごとにワイプ（更新が変わった文字だけ書き換える）
      for (const c of it.chars) {
        const p = c.e > c.s ? clamp((t - c.s) / (c.e - c.s), 0, 1) : (t >= c.s ? 1 : 0);
        setVar(c.el, p);
      }
    }
  }

  _findLine(t) {
    const items = this.items;
    let lo = 0, hi = items.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].start <= t) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    // 前の行の余韻中はそちらを優先（end を過ぎて 0.6 秒以内）
    if (ans > 0 && items[ans - 1].end > t && items[ans - 1].end + 0.6 > t && items[ans].start > t) {
      return ans - 1;
    }
    return ans;
  }

  _applyClasses(idx) {
    this.items.forEach((it, i) => {
      const cls = ['lyric-line'];
      if (i === idx) cls.push('active');
      else if (i === idx - 1) cls.push('prev');
      else if (i === idx + 1) cls.push('next');
      else cls.push('far');
      it.el.className = cls.join(' ');

      // 表示外の行のワイプ位置をリセット / 終わった行は完成状態へ
      if (i < idx) this._setAll(it, 1);
      else if (i > idx) this._setAll(it, 0);
    });
  }

  _setAll(it, p) {
    if (it.painted === p) return;
    it.painted = p;
    if (it.level) setVar(it.el, p);
    else for (const c of it.chars) setVar(c.el, p);
  }
}

function setVar(el, p) {
  // 0.1% 単位に丸めて無駄な再描画を避ける
  const v = Math.round(p * 1000) / 1000;
  if (el.__p === v) return;
  el.__p = v;
  el.style.setProperty('--p', v);
}

/** 歌詞行 + 音節から「文字ごとの start/end」を作る（不可能なら null） */
function computeCharTimes(line, chars) {
  const syllables = line.syllables || [];
  const start = line.start || 0;
  const end = line.end || 0;

  if (syllables.length && syllables.some((s) => s.start > 0)) {
    const out = [];
    for (const s of syllables) {
      const sc = Array.from(s.text || '');
      const sStart = Number(s.start) || 0;
      const sEnd = Number(s.end) || sStart;
      if (!sc.length) continue;
      const step = (sEnd - sStart) / sc.length;
      for (let i = 0; i < sc.length; i++) {
        out.push({ s: sStart + step * i, e: sStart + step * (i + 1) });
      }
    }
    // 文字数が合っているときだけ採用
    if (out.length === chars.length) return out;
  }

  if (end > start && chars.length) {
    const step = (end - start) / chars.length;
    return chars.map((_, i) => ({ s: start + step * i, e: start + step * (i + 1) }));
  }
  return null;
}

/**
 * 行データへ音節(文字分割)を自動生成する（エディタ用ヘルパ）
 */
export function splitSyllables(line) {
  const chars = Array.from(line.text || '');
  if (!chars.length || !(line.end > line.start)) return [];
  const step = (line.end - line.start) / chars.length;
  return chars.map((c, i) => ({ text: c, start: line.start + step * i, end: line.start + step * (i + 1) }));
}
