// scoring.js — リアルタイム採点
//   ノート単位で「どのくらい音程に乗っていたか」を積算し、
//   ノート終了時に Perfect / Good / Miss を判定する。
//
import { TOLERANCE } from './pitch.js';

const SCORE_PERFECT = 100;
const SCORE_GOOD = 60;
const SCORE_MAX = 10000;

export class Scorer {
  /**
   * @param {Array} notes  [{start, dur, end, midi}] (秒・昇順)
   * @param {Object} opt   { difficulty, lines }
   */
  constructor(notes, opt = {}) {
    this.notes = (notes || []).slice().sort((a, b) => a.start - b.start);
    this.lines = opt.lines || [];
    this.difficulty = opt.difficulty || 'normal';
    this.offset = 0;          // キー変更によるターゲットの移動量(半音)
    this.enabled = true;      // マイク未接続時は false
    this.states = this._newStates(0);
    this.cursor = 0;
    this.trail = [];          // グラフ用 {t, err, midi, target}
    this.onJudge = null;
    this._lastTrailT = -1;
  }

  _newStates(fromIndex) {
    const blank = () => ({ frames: 0, voiced: 0, hit: 0, hitGood: 0, sumErr: 0, judged: false, judgment: null });
    const arr = this.states && this.states.length === this.notes.length ? this.states : new Array(this.notes.length);
    for (let i = fromIndex; i < this.notes.length; i++) arr[i] = blank();
    for (let i = 0; i < fromIndex; i++) if (!arr[i]) arr[i] = blank();
    return arr;
  }

  setDifficulty(d) { this.difficulty = d; }
  setOffset(semis) { this.offset = semis || 0; }

  reset() {
    this.states = this.notes.map(() => ({ frames: 0, voiced: 0, hit: 0, hitGood: 0, sumErr: 0, judged: false, judgment: null }));
    this.cursor = 0;
    this.trail = [];
    this._lastTrailT = -1;
  }

  /** seek 時: 指定時刻より前の判定だけ残してリセット */
  resetTo(time) {
    const blank = () => ({ frames: 0, voiced: 0, hit: 0, hitGood: 0, sumErr: 0, judged: false, judgment: null });
    this.states = this.notes.map((n, i) => (n.end <= time && this.states[i] ? this.states[i] : blank()));
    this.cursor = 0;
    while (this.cursor < this.notes.length && this.notes[this.cursor].end <= time) this.cursor++;
    this.trail = this.trail.filter((p) => p.t < time);
    this._lastTrailT = -1;
  }

  get tol() { return TOLERANCE[this.difficulty] || TOLERANCE.normal; }

  /**
   * 毎フレーム呼ぶ
   * @param {number} time      曲内時刻(秒)
   * @param {number|null} midi 検出されたユーザーの音高(半音, 小数)
   */
  update(time, midi) {
    if (!this.enabled || !this.notes.length) return;

    // 1) 終了したノートを判定
    while (this.cursor < this.notes.length && this.notes[this.cursor].end <= time) {
      this._judge(this.cursor);
      this.cursor++;
    }

    const tol = this.tol;
    let activeIndex = -1;

    // 2) 進行中のノートへフレームを加算
    for (let i = this.cursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.start > time) break;
      if (n.end <= time) continue;
      const st = this.states[i];
      if (!st || st.judged) continue;
      st.frames++;
      activeIndex = activeIndex < 0 ? i : activeIndex;
      if (midi != null) {
        st.voiced++;
        const err = midi - (n.midi + this.offset);
        if (Math.abs(err) <= tol.perfect) st.hit++;
        if (Math.abs(err) <= tol.good) st.hitGood++;
        st.sumErr += err;
      }
    }

    // 3) グラフ用の軌跡
    if (activeIndex >= 0 && time - this._lastTrailT >= 0.033) {
      const n = this.notes[activeIndex];
      this._lastTrailT = time;
      this.trail.push(midi != null
        ? { t: time, err: midi - (n.midi + this.offset), midi, target: n.midi + this.offset }
        : { t: time, err: null, midi: null, target: n.midi + this.offset });
      if (this.trail.length > 6000) this.trail.shift();
    }
  }

  _judge(i) {
    const st = this.states[i];
    if (!st || st.judged) return;
    st.judged = true;
    let judgment = 'miss';
    if (st.voiced >= 3) {
      const perfectRatio = st.hit / st.voiced;
      const goodRatio = (st.hitGood || 0) / st.voiced;
      if (perfectRatio >= 0.72) judgment = 'perfect';
      else if (goodRatio >= 0.4) judgment = 'good';
    }
    st.judgment = judgment;
    if (this.onJudge) this.onJudge(judgment, this.notes[i], i, this.combo);
  }

  /** 未判定のノートもまとめて確定（終了時） */
  finalize() {
    if (!this.enabled) return;   // マイク未接続時は採点しない
    for (let i = 0; i < this.notes.length; i++) {
      if (!this.states[i].judged) this._judge(i);
    }
  }

  get combo() {
    let c = 0;
    for (let i = 0; i < this.states.length; i++) {
      const j = this.states[i].judgment;
      if (!j) break;
      if (j === 'miss') c = 0;
      else c++;
    }
    return c;
  }

  get counts() {
    let perfect = 0, good = 0, miss = 0, pending = 0;
    for (const st of this.states) {
      if (!st.judged) { pending++; continue; }
      if (st.judgment === 'perfect') perfect++;
      else if (st.judgment === 'good') good++;
      else miss++;
    }
    return { perfect, good, miss, pending };
  }

  get earned() {
    const c = this.counts;
    return c.perfect * SCORE_PERFECT + c.good * SCORE_GOOD;
  }

  get score() {
    const total = Math.max(1, this.notes.length * SCORE_PERFECT);
    return Math.round((SCORE_MAX * this.earned) / total);
  }

  get maxCombo() {
    let best = 0, cur = 0;
    for (const st of this.states) {
      if (!st.judged) break;
      if (st.judgment === 'miss') cur = 0;
      else { cur++; best = Math.max(best, cur); }
    }
    return best;
  }

  /** 音程一致率 0〜1（Perfect帯=1.0 / Good帯=0.6 で加重した発声フレームの合致割合） */
  get accuracy() {
    let voiced = 0, hit = 0, good = 0, errSum = 0, errN = 0;
    for (const st of this.states) {
      voiced += st.voiced;
      hit += st.hit;
      good += st.hitGood || 0;
      if (st.voiced) { errSum += Math.abs(st.sumErr) / st.voiced; errN++; }
    }
    const weighted = hit + 0.6 * Math.max(0, good - hit);
    return { ratio: voiced ? weighted / voiced : 0, voiced, hit, meanErr: errN ? errSum / errN : 0 };
  }

  /** ライブ表示用 */
  get live() {
    const c = this.counts;
    return {
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      perfect: c.perfect,
      good: c.good,
      miss: c.miss,
      pending: c.pending,
      accuracy: this.accuracy,
    };
  }

  /** リザルト用スナップショット */
  result() {
    this.finalize();
    const c = this.counts;
    const acc = this.accuracy;
    return {
      score: this.score,
      perfect: c.perfect,
      good: c.good,
      miss: c.miss,
      maxCombo: this.maxCombo,
      accuracy: Math.round(acc.ratio * 1000) / 10,
      meanErr: Math.round(acc.meanErr * 100) / 100,
      total: this.notes.length,
      trail: this.trail,
      notes: this.notes,
      states: this.states,
      lineScores: this.lineScores(),
    };
  }

  /** 歌詞行ごとのスコア（リザルトの棒グラフ用） */
  lineScores() {
    const lines = this.lines.length ? this.lines : autoGroup(this.notes);
    return lines.map((ln) => {
      const idxs = [];
      this.notes.forEach((n, i) => { if (n.start >= ln.start - 0.01 && n.start <= ln.end + 0.01) idxs.push(i); });
      if (!idxs.length) return null;
      let earned = 0;
      for (const i of idxs) {
        const j = this.states[i].judgment;
        earned += j === 'perfect' ? SCORE_PERFECT : j === 'good' ? SCORE_GOOD : 0;
      }
      return {
        text: ln.text || '',
        start: ln.start,
        ratio: earned / (idxs.length * SCORE_PERFECT),
        count: idxs.length,
      };
    }).filter(Boolean);
  }
}

/** 歌詞行が無ければノートの間隔で自動グループ化 */
function autoGroup(notes) {
  const groups = [];
  let cur = null;
  for (const n of notes) {
    if (!cur || n.start - cur.end > 1.2) {
      cur = { start: n.start, end: n.end, text: '' };
      groups.push(cur);
    } else {
      cur.end = Math.max(cur.end, n.end);
    }
  }
  return groups;
}
