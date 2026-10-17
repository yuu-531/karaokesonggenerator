// demo.js — 内蔵デモ曲の自動生成
//   自作の旋律・伴奏を Web Audio (OfflineAudioContext) で合成し、
//   .ksg と同じ構造 { info, lyrics, midi, audio } を返す。
//   （MP3 エンコーダを持ち込まないため音源は WAV として格納する）
//
import { writeMidi } from './midi.js';

const BPM = 120;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const INTRO = BAR;           // 1小節イントロ
const OUTRO = BAR;

// 原创フレーズ（音節 = 文字、1文字 1ノート）
const LINES = [
  { text: 'きらきらひかる',  pitches: [64, 67, 69, 67, 64, 62, 60], beats: [1, 1, 1, 1, 1, 1, 2], chord: 'C' },
  { text: 'そらのしたで',    pitches: [65, 69, 67, 65, 64, 62],      beats: [1, 1, 2, 1, 1, 2],    chord: 'F' },
  { text: 'こえをあげよう',  pitches: [69, 72, 71, 69, 67, 64, 64],  beats: [1, 1, 1, 1, 1, 1, 2], chord: 'Am' },
  { text: 'あしたへとつづく', pitches: [67, 71, 74, 71, 72, 71, 69, 67], beats: [1, 1, 1, 1, 1, 1, 1, 1], chord: 'G' },
  { text: 'みちをゆっくり',  pitches: [65, 67, 69, 72, 69, 67, 65],  beats: [1, 1, 1, 1, 1, 1, 2], chord: 'F' },
  { text: 'あるいてゆこう',  pitches: [67, 65, 64, 62, 60, 62, 60],  beats: [1, 1, 1, 1, 1, 2, 1], chord: 'C' },
];

const CHORDS = {
  C:  { root: 36, triad: [60, 64, 67] },
  F:  { root: 41, triad: [53, 57, 60] },
  Am: { root: 45, triad: [57, 60, 64] },
  G:  { root: 43, triad: [55, 59, 62] },
};

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

/** メロディノートと歌詞タイムスタンプを作る */
function buildScore() {
  const notes = [];
  const lyricLines = [];
  const lyricEvents = [];
  let t = INTRO;

  LINES.forEach((ln) => {
    const lineStart = t;
    let acc = t;
    const syllables = [];
    const chars = Array.from(ln.text);

    chars.forEach((ch, i) => {
      const durBeats = ln.beats[i] || 1;
      const start = acc;
      const end = acc + durBeats * BEAT;
      notes.push({ start, dur: (end - start) * 0.94, midi: ln.pitches[i], velocity: 100 });
      syllables.push({ text: ch, start: round2(start), end: round2(end) });
      lyricEvents.push({ time: start, text: ch });
      acc = end;
    });

    lyricLines.push({ text: ln.text, start: round2(lineStart), end: round2(acc), syllables });
    t = acc;
  });

  return { notes, lyricLines, lyricEvents, endTime: t };
}

function round2(v) { return Math.round(v * 100) / 100; }

/** 伴奏つきでオフラインレンダリング */
async function renderAudio(score) {
  const sr = 44100;
  const total = score.endTime + OUTRO;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OAC(2, Math.ceil(sr * total), sr);

  const bus = ctx.createGain();
  bus.gain.value = 0.8;
  bus.connect(ctx.destination);

  // --- 助け関数 ---
  const tone = (freq, at, dur, { type = 'sine', gain = 0.2, attack = 0.01, release = 0.12, detune = 0, filter = 0 } = {}) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + attack);
    g.gain.setValueAtTime(gain, at + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node = osc;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = filter;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(bus);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  };

  const noiseBuf = ctx.createBuffer(1, Math.floor(sr * 0.5), sr);
  {
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const noise = (at, dur, gain, hp) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hp;
    src.connect(f); f.connect(g); g.connect(bus);
    src.start(at);
    src.stop(at + dur + 0.02);
  };

  const kick = (at) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(120, at);
    osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    g.gain.setValueAtTime(0.5, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
    osc.connect(g); g.connect(bus);
    osc.start(at); osc.stop(at + 0.3);
  };

  // --- メロディ（パッドより少し明るいトーン） ---
  for (const n of score.notes) {
    tone(midiToFreq(n.midi), n.start, n.dur, { type: 'triangle', gain: 0.17, attack: 0.02, release: 0.08, filter: 4000 });
    tone(midiToFreq(n.midi) * 2, n.start, n.dur, { type: 'sine', gain: 0.05, attack: 0.03, release: 0.1 });
  }

  // --- ベース / コード / パーカッション ---
  const totalBars = Math.ceil((score.endTime + OUTRO) / BAR);
  for (let bar = 0; bar < totalBars; bar++) {
    const at = bar * BAR;
    const chordKey = at < INTRO ? 'C' : LINES[Math.min(LINES.length - 1, Math.floor((at - INTRO) / (BAR * 2)))].chord;
    const ch = CHORDS[chordKey] || CHORDS.C;

    // ベース
    tone(midiToFreq(ch.root), at, BEAT * 1.8, { type: 'sine', gain: 0.34, attack: 0.005, release: 0.15 });
    tone(midiToFreq(ch.root), at + BEAT * 2, BEAT * 1.8, { type: 'sine', gain: 0.3, attack: 0.005, release: 0.15 });

    // コードパッド
    for (const m of ch.triad) {
      tone(midiToFreq(m), at, BAR * 0.95, { type: 'sawtooth', gain: 0.035, attack: 0.15, release: 0.4, filter: 1500 });
      tone(midiToFreq(m) * 1.005, at, BAR * 0.95, { type: 'sawtooth', gain: 0.03, attack: 0.18, release: 0.4, filter: 1300, detune: 6 });
    }

    // パーカッション
    for (let b = 0; b < 8; b++) {
      const tt = at + b * BEAT * 0.5;
      noise(tt, 0.05, b % 2 === 0 ? 0.10 : 0.055, 7000);
    }
    if (at >= INTRO) {
      kick(at);
      kick(at + BEAT * 2);
    }
  }

  const rendered = await ctx.startRendering();
  return rendered;
}

/** AudioBuffer → 16bit PCM WAV Blob */
export function encodeWav(buffer) {
  const numCh = Math.min(2, buffer.numberOfChannels);
  const len = buffer.length;
  const sr = buffer.sampleRate;
  const bytes = 44 + len * numCh * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);

  const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF');
  dv.setUint32(4, bytes - 8, true);
  wstr(8, 'WAVE');
  wstr(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);              // PCM
  dv.setUint16(22, numCh, true);
  dv.setUint32(24, sr, true);
  dv.setUint32(28, sr * numCh * 2, true);
  dv.setUint16(32, numCh * 2, true);
  dv.setUint16(34, 16, true);
  wstr(36, 'data');
  dv.setUint32(40, len * numCh * 2, true);

  const chans = [];
  for (let c = 0; c < numCh; c++) chans.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      let v = chans[c][i];
      v = Math.max(-1, Math.min(1, v));
      dv.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/**
 * デモ曲一式を生成する
 * @returns {{info, lyrics, midi, audioBlob, audioName}}
 */
export async function generateDemo(onProgress) {
  if (onProgress) onProgress('メロディを作成中…');
  const score = buildScore();

  if (onProgress) onProgress('伴奏をレンダリング中…');
  const audioBuf = await renderAudio(score);

  if (onProgress) onProgress('WAV をエンコード中…');
  const audioBlob = encodeWav(audioBuf);

  if (onProgress) onProgress('MIDI / 歌詞を書き出し中…');
  const midi = writeMidi(score.notes, { bpm: BPM, lyrics: score.lyricEvents, program: 73 });

  const lyrics = { version: 1, lines: score.lyricLines };
  const info = {
    version: 1,
    title: 'ひかるあさ（デモ曲）',
    artist: 'Karaoke Song Generator',
    bpm: BPM,
    key: 0,
    offset: 0,
    duration: round2(audioBuf.duration),
    demo: true,
  };

  if (onProgress) onProgress('完了');
  return { info, lyrics, midi, audioBlob, audioName: 'audio.wav' };
}
