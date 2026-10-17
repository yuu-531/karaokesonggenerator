// audio-engine.js — Web Audio API エンジン
//   ・伴奏の再生（キー変更 / スピード変更 / ピッチ補正）
//   ・ボーカル用エコー（ディレイ + 残響コンボリューション）
//   ・マイク入力（解析用 / 録音用 / 監視用）
//   ・伴奏 + ボーカルのミックス録音（MediaRecorder）
//
import { analyzePitch } from './pitch.js';

const WORKLET_URL = 'js/worklet/pitch-shifter.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.workletReady = false;
    this.playing = false;
    this.origin = 0;           // time = ctx.currentTime - origin - delaySec
    this.pausedAt = 0;

    this.speed = 1;
    this.transpose = 0;
    this.pitchFix = true;
    this.echo = 25;
    this.volume = 1;           // 楽曲の再生音量 (0〜1)
    this.monitor = false;

    this.micStream = null;
    this.micOn = false;
    this.micError = null;

    this.recorder = null;
    this.recChunks = [];
    this.onEnded = null;
    this.onStateChange = null;
  }

  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  /** AudioContext と全グラフを初期化（ユーザー操作から呼ぶこと） */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const ctx = this.ctx;

    // --- ノード作成 ---
    this.musicGain = ctx.createGain();      // 伴奏の音量
    this.musicGain.gain.value = 0.9;
    this.musicVol = ctx.createGain();       // 楽曲の再生音量（UI の音量スライダー）
    this.musicVol.gain.value = this.volume;
    this.master = ctx.createGain();
    this.master.gain.value = 1.0;
    this.musicGain.connect(this.musicVol);
    this.musicVol.connect(this.master);
    this.master.connect(ctx.destination);

    // 録音バス（伴奏 + ボーカル）
    this.recDest = ctx.createMediaStreamDestination();
    this.musicGain.connect(this.recDest);

    // --- ピッチシフタ (AudioWorklet) ---
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      const node = new AudioWorkletNode(ctx, 'pitch-shifter', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'max',
      });
      node.connect(this.musicGain);
      this.shifter = node;
      this.ratioParam = node.parameters.get('ratio');
      this.workletReady = true;
    } catch (e) {
      console.warn('[audio] AudioWorklet ピッチシフタを初期化できません（テープ式にフォールバック）', e);
      this.shifter = null;
      this.workletReady = false;
    }

    // --- ボーカル用エコー（ディレイ + 残響） ---
    this.sendGain = ctx.createGain();
    this.sendGain.gain.value = 0;

    const conv = ctx.createConvolver();
    conv.buffer = makeImpulseResponse(ctx, 1.9, 2.6);
    const convGain = ctx.createGain();
    convGain.gain.value = 0.7;
    this.sendGain.connect(conv);
    conv.connect(convGain);
    convGain.connect(this.master);
    convGain.connect(this.recDest);

    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.17;
    const fb = ctx.createGain();
    fb.gain.value = 0.38;
    const echoGain = ctx.createGain();
    echoGain.gain.value = 0.55;
    this.sendGain.connect(delay);
    delay.connect(fb);
    fb.connect(delay);
    delay.connect(echoGain);
    echoGain.connect(this.master);
    echoGain.connect(this.recDest);

    this.setEcho(this.echo);

    if (ctx.state === 'suspended') await ctx.resume();
  }

  /** 音源（ArrayBuffer）をデコードして保持 */
  async load(arrayBuffer) {
    await this.init();
    const ctx = this.ctx;
    const ab = arrayBuffer instanceof ArrayBuffer ? arrayBuffer.slice(0) : arrayBuffer;
    let buffer;
    try {
      buffer = await ctx.decodeAudioData(ab);
    } catch (e) {
      // Safari フォールバック
      buffer = await new Promise((res, rej) => ctx.decodeAudioData(ab, res, rej));
    }
    this.buffer = buffer;
    this.stop();
    return buffer;
  }

  get duration() { return this.buffer ? this.buffer.duration : 0; }

  /** ピッチシフタが必要とする理論上の出力遅延（秒） — worklet の delayFor() と一致させる */
  get delaySec() {
    if (!this.workletReady || !this.ctx) return 0;
    const L = Math.max(64, Math.round(this.ctx.sampleRate * 0.04));
    const W = 512;                                  // worklet の相関探索幅
    const r = this._currentRatio();
    return (Math.max(0, Math.ceil((r - 1) * L)) + W + 8) / this.ctx.sampleRate;
  }

  _currentRatio() {
    if (!this.workletReady) return 1;
    if (!this.pitchFix) return 1;
    return Math.pow(2, this.transpose / 12) / this.speed;
  }

  /** 現在聽到いている音の実効キーずれ（半音）。採点・音程バーはこの値を使う */
  get pitchOffsetSemis() {
    if (this.workletReady && this.pitchFix) return this.transpose;
    // テープ式: スピード変更はキーにも影響する
    return this.transpose + 12 * Math.log2(this.speed);
  }

  /** 再生中の曲内時刻（秒）— 遅延補正済み */
  get time() {
    if (!this.ctx) return this.pausedAt;
    if (!this.playing) return this.pausedAt;
    return Math.max(0, this.ctx.currentTime - this.origin - this.delaySec);
  }

  get paused() { return !this.playing; }

  _stopSource() {
    if (this.source) {
      try { this.source.onended = null; this.source.stop(); } catch (e) { /* already stopped */ }
      try { this.source.disconnect(); } catch (e) { /* */ }
      this.source = null;
    }
  }

  /** 再生 */
  async play(from = 0) {
    await this.init();
    if (!this.buffer) throw new Error('音源がロードされていません');
    this._stopSource();

    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.speed;

    if (this.workletReady) {
      src.detune.value = this.pitchFix ? 0 : this.transpose * 100;
      this.ratioParam.value = this._currentRatio();
      src.connect(this.shifter);
    } else {
      src.detune.value = this.transpose * 100;
      src.connect(this.musicGain);
    }

    const fromNum = Number(from);
    const safeFrom = Number.isFinite(fromNum) ? fromNum : 0;
    const start = Math.max(0, Math.min(safeFrom, this.duration - 0.01));
    src.start(0, start);
    this.origin = ctx.currentTime - start;
    this.source = src;
    this.playing = true;
    this.pausedAt = start;
    src.onended = () => {
      if (this.source === src && this.playing && this.time >= this.duration - 0.05) {
        this.playing = false;
        this.pausedAt = this.duration;
        if (this.onEnded) this.onEnded();
      }
    };
    if (this.onStateChange) this.onStateChange();
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = this.time;
    this.playing = false;
    this._stopSource();
    if (this.onStateChange) this.onStateChange();
  }

  stop() {
    this.playing = false;
    this._stopSource();
    this.pausedAt = 0;
    if (this.onStateChange) this.onStateChange();
  }

  /** 指定位置へシーク（再生中ならその位置から継続） */
  async seek(t) {
    const n = Number(t);
    const target = Number.isFinite(n) ? Math.max(0, Math.min(n, this.duration || 0)) : 0;
    if (this.playing) await this.play(target);
    else this.pausedAt = target;
  }

  async toggle() {
    if (this.playing) this.pause();
    else await this.play(this.pausedAt >= this.duration ? 0 : this.pausedAt);
  }

  // ---------------- パラメータ ----------------
  async setSpeed(v) {
    this.speed = Math.min(2, Math.max(0.5, v));
    if (this.source && this.ctx) {
      this.source.playbackRate.setTargetAtTime(this.speed, this.ctx.currentTime, 0.02);
      if (this.workletReady) this.ratioParam.value = this._currentRatio();
    }
  }

  async setTranspose(v) {
    this.transpose = Math.max(-12, Math.min(12, Math.round(v)));
    if (this.source && this.ctx) {
      if (this.workletReady) {
        this.ratioParam.value = this._currentRatio();
        if (!this.pitchFix) this.source.detune.setTargetAtTime(this.transpose * 100, this.ctx.currentTime, 0.02);
      } else {
        this.source.detune.setTargetAtTime(this.transpose * 100, this.ctx.currentTime, 0.02);
      }
    }
  }

  setPitchFix(on) {
    this.pitchFix = !!on;
    if (this.source && this.ctx) {
      if (this.workletReady) {
        this.ratioParam.value = this._currentRatio();
        this.source.detune.setTargetAtTime(this.pitchFix ? 0 : this.transpose * 100, this.ctx.currentTime, 0.02);
      } else {
        this.source.detune.setTargetAtTime(this.transpose * 100, this.ctx.currentTime, 0.02);
      }
    }
  }

  /** エコー量 0〜100 */
  setEcho(pct) {
    this.echo = Math.max(0, Math.min(100, pct));
    if (this.sendGain && this.ctx) {
      const g = (this.echo / 100) * 0.85;
      this.sendGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.05);
    }
  }

  /**
   * 楽曲の再生音量 (0〜1)。スライダー連動でもプチノイズが出ないようラップ時間で補間する。
   * 伴奏のみを経路に入れるため、録音される音量とマイク監視の音量には影響しない。
   */
  setVolume(v) {
    const val = Number(v);
    if (!isFinite(val)) return;
    this.volume = Math.max(0, Math.min(1, val));
    if (this.musicVol && this.ctx) {
      const t = this.ctx.currentTime;
      this.musicVol.gain.cancelScheduledValues(t);
      this.musicVol.gain.setTargetAtTime(this.volume, t, 0.02);
    }
  }

  // ---------------- マイク ----------------
  async enableMic() {
    await this.init();
    if (this.micStream) { this.micOn = true; return true; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.micError = 'このブラウザは getUserMedia 非対応です';
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
      this.micStream = stream;
      const ctx = this.ctx;
      this.micSrc = ctx.createMediaStreamSource(stream);
      this.micGain = ctx.createGain();
      this.micGain.gain.value = 1;
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 2048;
      this.micAnalyser.smoothingTimeConstant = 0;

      this.micSrc.connect(this.micGain);
      this.micGain.connect(this.micAnalyser);
      this.micGain.connect(this.recDest);          // 録音には必ず声をミックス

      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = this.monitor ? 1 : 0;
      this.micGain.connect(this.monitorGain);
      this.monitorGain.connect(this.master);

      stream.getAudioTracks().forEach((tr) => {
        tr.onended = () => this.disableMic();
      });
      this.micOn = true;
      this.micError = null;
      return true;
    } catch (e) {
      this.micError = e && e.name ? `${e.name}: ${e.message}` : String(e);
      this.micOn = false;
      return false;
    }
  }

  disableMic() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      try { this.micSrc && this.micSrc.disconnect(); } catch (e) { /* */ }
      try { this.micGain && this.micGain.disconnect(); } catch (e) { /* */ }
      try { this.monitorGain && this.monitorGain.disconnect(); } catch (e) { /* */ }
    }
    this.micStream = null;
    this.micSrc = null;
    this.micGain = null;
    this.micAnalyser = null;
    this.micOn = false;
  }

  setMonitor(on) {
    this.monitor = !!on;
    if (this.monitorGain && this.ctx) {
      this.monitorGain.gain.setTargetAtTime(this.monitor ? 1 : 0, this.ctx.currentTime, 0.03);
    }
  }

  /** 現在のピッチを解析（未接続なら null） */
  getPitch() {
    if (!this.micOn || !this.micAnalyser) return { midi: null, level: 0, freq: null };
    return analyzePitch(this.micAnalyser);
  }

  // ---------------- 録音 ----------------
  static pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const cands = [
      ['audio/webm;codecs=opus', 'webm'],
      ['audio/webm', 'webm'],
      ['audio/ogg;codecs=opus', 'ogg'],
      ['audio/mp4', 'm4a'],
      ['audio/aac', 'aac'],
      ['', 'webm'],
    ];
    for (const [m, ext] of cands) {
      try {
        if (!m || MediaRecorder.isTypeSupported(m)) return { mime: m, ext };
      } catch (e) { /* */ }
    }
    return null;
  }

  startRecording() {
    if (!this.ctx) throw new Error('先にエンジンを初期化してください');
    if (typeof MediaRecorder === 'undefined') throw new Error('このブラウザは録音非対応です');
    const picked = AudioEngine.pickMime();
    const opts = {};
    if (picked && picked.mime) opts.mimeType = picked.mime;
    this.recorder = new MediaRecorder(this.recDest.stream, opts);
    this.recChunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.recChunks.push(e.data); };
    this.recorder.start(200);
    this.recExt = (picked && picked.ext) || 'webm';
    return true;
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this.recorder || this.recorder.state === 'inactive') { resolve(null); return; }
      const rec = this.recorder;
      rec.onstop = () => {
        const blob = new Blob(this.recChunks, { type: rec.mimeType || 'audio/webm' });
        this.recorder = null;
        this.recChunks = [];
        resolve({ blob, ext: this.recExt || 'webm' });
      };
      rec.stop();
    });
  }

  get recording() { return !!(this.recorder && this.recorder.state === 'recording'); }
}

/** ノイズ減衰するインパルス応答を生成（残響用） */
function makeImpulseResponse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, decay);
      // ローパスをかけたようなノイズ（前のサンプルとの補間）
      const white = Math.random() * 2 - 1;
      last = last * 0.35 + white * 0.65;
      data[i] = last * env * (ch === 0 ? 1 : 0.92);
    }
    // 先頭のディレイ（板の距離感）
    const pre = Math.floor(rate * 0.012);
    for (let i = 0; i < pre; i++) data[i] *= i / pre;
  }
  return buf;
}
