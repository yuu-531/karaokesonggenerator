// tone.js — 編集操作時の試聴音（ピープ音）
//
//   ・エディタのノート選択 / 作成 / ドラッグ中の音高変化 / 鍵盤クリックで発音
//   ・Web Audio の OscillatorNode だけで生成（音源ファイル不要・軽量）
//   ・AudioContext は初回回発音時に遅延生成（ユーザー操作の起点になるため自動再生制限に抵触しない）
//
let ctx = null;
let enabled = true;

/** 試聴音の ON / OFF */
export function setToneEnabled(v) { enabled = !!v; }
export function isToneEnabled() { return enabled; }

function ac() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch (e) {
    console.warn('[tone] AudioContext を作れません', e);
    return null;
  }
}

/**
 * MIDI 値を鳴らす
 * @param {number} midi  0〜127
 * @param {Object} opt   { dur:秒, gain:0〜1, type:oscillatorType }
 */
export function tone(midi, opt = {}) {
  if (!enabled) return;
  const a = ac();
  if (!a) return;

  const m = Math.max(0, Math.min(127, Number(midi) || 60));
  const f = 440 * Math.pow(2, (m - 69) / 12);
  const dur = opt.dur || 0.26;
  const peak = opt.gain || 0.16;
  const t0 = a.currentTime;

  // 基音（三角波＝柔らかい）＋ 2倍音（正弦波で芯を足す）
  const osc = a.createOscillator();
  osc.type = opt.type || 'triangle';
  osc.frequency.setValueAtTime(f, t0);

  const osc2 = a.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(f * 2, t0);

  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  const g2 = a.createGain();
  g2.gain.setValueAtTime(0.0001, t0);
  g2.gain.exponentialRampToValueAtTime(peak * 0.22, t0 + 0.012);
  g2.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * 0.6);

  osc.connect(g).connect(a.destination);
  osc2.connect(g2).connect(a.destination);
  osc.start(t0);
  osc2.start(t0);
  osc.stop(t0 + dur + 0.05);
  osc2.stop(t0 + dur + 0.05);
}
