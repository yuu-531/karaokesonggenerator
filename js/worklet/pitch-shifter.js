// js/worklet/pitch-shifter.js
// リアルタイムピッチシフタ（グラニュラ + WSOLA 相関探索）
//
//   ・音程比 ratio = 出力音程 / 入力音程
//   ・grain(粒) を Hs サンプルごとに切り替え、粒内は ratio 倍の速度で読み出す
//   ・粒の境界では「期待位置」から W サンプルの範囲で正規化相互相関を最大化する
//     位置を探して読み出し位置を選ぶ（WSOLA）。これにより接続点の位相が揃い、
//     グラニュラ特有の周波数ゆらぎ（チャンir）が出ない。
//   ・ratio == 1 のときは探索を省略し、完全な identity（無劣化パススルー）
//   ・r > 1 では読み出しが先走るため遅延 D = L*(r-1) + W + 8 を確保
//     （エンジン側も同じ式で遅延を補正して音声・映像・字幕を同期する）
//
class PitchShifterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'ratio',
      defaultValue: 1,
      minValue: 0.25,
      maxValue: 4,
      automationRate: 'k-rate',
    }];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.L = Math.max(64, Math.round(sr * 0.04));   // grain 長 ≒ 40ms
    this.Hs = Math.round(this.L / 2);               // grain 切り替え周期
    this.W = 512;                                   // 相関探索の半幅
    let n = 1;
    while (n < sr * 0.5) n <<= 1;
    this.N = n;
    this.mask = n - 1;

    this.chBufs = [];
    this.n = 0;
    this.ratio = 1;
    this.pending = 1;
    this._ref = new Float32Array(640);   // 参照シグナル
    this._stats = { searched: 0 };

    const d = this.delayFor(1);
    this.cur = { out: 0, in: 0 - d, r: 1 };
    this.prev = null;

    // Hanning 窓（50% 重ね合わせで和が 1 になる）
    this.win = new Float32Array(this.L + 1);
    for (let i = 0; i <= this.L; i++) {
      this.win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.L));
    }
  }

  delayFor(r) {
    return Math.max(0, Math.ceil((r - 1) * this.L)) + this.W + 8;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const len = output[0].length;
    const nOut = output.length;
    const inCh = input ? input.length : 0;

    const ratio = parameters.ratio && parameters.ratio.length ? parameters.ratio[0] : 1;
    const pr = Math.min(3, Math.max(0.3, ratio));
    if (Math.abs(pr - this.pending) > 1e-4) this.pending = pr;

    const need = Math.max(inCh, nOut, 1);
    while (this.chBufs.length < need) this.chBufs.push(new Float32Array(this.N));

    const { L, Hs, win, mask } = this;

    for (let i = 0; i < len; i++) {
      // --- grain境界（新しい ratio はここで反映） ---
      if (this.n >= this.cur.out + Hs) {
        const prev = this.cur;
        const outStart = prev.out + Hs;
        const r = this.pending;
        const anchor = outStart - this.delayFor(r);
        let s = anchor;
        if (Math.abs(r - 1) > 0.01) s = this.search(prev, r, anchor);
        this.prev = prev;
        this.cur = { out: outStart, in: s, r };
      }

      const n = this.n;

      // --- 入力書き込み ---
      for (let c = 0; c < this.chBufs.length; c++) {
        let v = 0;
        if (inCh > 0) {
          const ch = input[c] || input[0];
          if (ch) v = ch[i];
        }
        this.chBufs[c][n & mask] = v;
      }

      // --- 読み出し位置と窓 ---
      const g = this.cur;
      const kA = n - g.out;
      const posA = g.in + g.r * kA;
      const wA = kA >= 0 && kA < L ? win[kA | 0] : 0;

      const p = this.prev;
      let posB = 0, wB = 0;
      if (p) {
        const kB = n - p.out;
        if (kB >= 0 && kB < L) {
          wB = win[kB | 0];
          posB = p.in + p.r * kB;
        }
      }

      // --- 合成 ---
      for (let c = 0; c < nOut; c++) {
        const buf = this.chBufs[c] || this.chBufs[0];
        let s = 0;
        if (wA !== 0) s += wA * this.read(buf, posA, n);
        if (wB !== 0) s += wB * this.read(buf, posB, n);
        output[c][i] = s;
      }

      this.n++;
    }
    return true;
  }

  /**
   * WSOLA: 旧 grain のオーバーラップ内容と位相が合う読み出し開始位置を探す。
   * @param prev  旧 grain {out, in, r}
   * @param r     新しい音程比
   * @param anchor 期待位置 (= out - D)
   * @returns {number} 読み出し開始位置
   */
  search(prev, r, anchor) {
    const buf = this.chBufs[0];
    if (!buf) return anchor;
    const n = this.n;
    const W = this.W;
    const Hs = this.Hs;

    // 旧 grain がオーバーラップ区間で読み出す軌跡 = 参照シグナル
    const refStart = prev.in + r * Hs;
    const avail = Math.floor((n - refStart) / r);
    const M = Math.min(Hs, 384, avail);
    if (M < 128) return anchor;

    const ref = this._ref;
    let refE = 0;
    for (let j = 0; j < M; j++) {
      const v = this.read(buf, refStart + r * j, n);
      ref[j] = v;
      refE += v * v;
    }
    if (refE < 1e-7) return anchor;                    // 無音時は探索しない

    const pMax = Math.floor((n - r * (M - 1)));
    const pMin = Math.ceil(r * 0) + 0;
    const lo = Math.max(pMin, anchor - W);
    const hi = Math.min(pMax, anchor + W);
    if (hi < lo) return anchor;

    const score = (p) => {
      let dot = 0, cE = 0;
      for (let j = 0; j < M; j++) {
        const v = this.read(buf, p + r * j, n);
        dot += ref[j] * v;
        cE += v * v;
      }
      return cE > 1e-9 ? dot / Math.sqrt(cE * refE) : -1;
    };

    // 粗探索 → 細探索
    let bestP = anchor, bestS = -2;
    for (let p = lo; p <= hi; p += 64) {
      const s = score(p);
      if (s > bestS) { bestS = s; bestP = p; }
    }
    const rLo = Math.max(lo, bestP - 64);
    const rHi = Math.min(hi, bestP + 64);
    for (let p = rLo; p <= rHi; p += 8) {
      const s = score(p);
      if (s > bestS) { bestS = s; bestP = p; }
    }
    // 低相関（ノイズ等）なら期待位置を使う
    return bestS > 0.25 ? bestP : anchor;
  }

  read(buf, pos, wpos) {
    if (!(pos >= 0) || pos > wpos) return 0;
    const i0 = pos | 0;
    const f = pos - i0;
    const a = buf[i0 & this.mask];
    const b = buf[(i0 + 1) & this.mask];
    return a + (b - a) * f;
  }
}

registerProcessor('pitch-shifter', PitchShifterProcessor);
