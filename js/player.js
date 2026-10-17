// player.js — プレイモード（歌う & 採点）
//   requestAnimationFrame で 音声 / 映像 / 字幕 / 音程バー / 採点 を
//   ミリ秒単位で同期させる。
//
import { $, clamp, formatTime, toast, download } from './util.js';
import { parseMidi } from './midi.js';
import { LyricsView } from './lyrics-view.js';
import { PitchLane } from './pitch-lane.js';
import { Scorer } from './scoring.js';
import { bestScore, addHighscore, loadSettings } from './store.js';

export class Player {
  constructor(engine) {
    this.engine = engine;
    this.song = null;          // { id, info, lyrics, notes, videoUrl, coverUrl }
    this.scorer = null;
    this.rafId = 0;
    this.state = 'idle';       // idle | ready | playing | paused | ended
    this.micOn = false;
    this.recordings = [];
    this.lastResult = null;
    this.settings = loadSettings();

    this.lyrics = new LyricsView($('#lyrics'));
    this.lane = new PitchLane($('#pitch-lane'));
    this.lane.scorer = null;

    this._bindUI();
    this._loop = this._loop.bind(this);
    this.engine.onEnded = () => this.finish();
    this.engine.onStateChange = () => this._syncPlayButton();
    this.lyrics.setGlow(this.settings.lyricsGlow);
    this._drawIdleLane();
  }

  // ------------------------------------------------------------------
  //  読み込み
  // ------------------------------------------------------------------
  /** IndexedDB のレコード or readKsg() の結果を読み込む */
  async loadSong(record) {
    this.stopAll();

    const info = record.info || {};
    const audioAb = record.audioArrayBuffer
      || (record.audioBlob ? await record.audioBlob.arrayBuffer() : null);
    if (!audioAb) throw new Error('音源がありません');

    const notes = (record.notes && record.notes.length)
      ? record.notes
      : (record.midi ? parseMidi(record.midi).notes : []);

    let videoUrl = null;
    if (record.videoBlob) videoUrl = URL.createObjectURL(record.videoBlob);

    this.song = {
      id: record.id || null,
      info,
      lyrics: record.lyrics || { version: 1, lines: [] },
      notes,
      videoUrl,
      audioName: record.audioName || 'audio.mp3',
    };

    // デコード（長い曲でも一瞬）
    await this.engine.load(audioAb);
    this.engine.setPitchFix(true);
    this.engine.setEcho(this.settings.defaultEcho != null ? this.settings.defaultEcho : 25);

    // UI
    $('#sp-title').textContent = info.title || '無題';
    $('#sp-artist').textContent = info.artist || '';
    $('#sp-hint').textContent = 'マイクを有効にして歌うと自動で採点します';
    $('#btn-start').disabled = false;
    $('#p-title').textContent = info.title || '無題';
    $('#p-artist').textContent = info.artist || '';
    $('#time-total').textContent = formatTime(this.engine.duration);
    $('#time-cur').textContent = '0:00';
    $('#progress-fill').style.width = '0%';
    $('#now-playing').textContent = `♪ ${info.title || '無題'}`;
    $('#now-playing').classList.remove('hidden');

    const best = this.song.id ? bestScore(this.song.id) : null;
    $('#p-best').textContent = best ? `ベストスコア: ${best.score.toLocaleString()} (${best.accuracy}%)` : 'ベストスコア: —';

    // 歌詞 / 音程バー / スコアラー
    this.lyrics.setData(this.song.lyrics, this.engine.duration);
    this.lane.setData(this.notes(), { bpm: info.bpm || 120, duration: this.engine.duration });

    this.scorer = new Scorer(this.notes(), {
      difficulty: this.settings.difficulty,
      lines: (this.song.lyrics && this.song.lyrics.lines) || [],
    });
    this.scorer.enabled = false;
    this.scorer.onJudge = (j, note, i, combo) => this._showJudge(j, combo);
    this.lane.scorer = this.scorer;

    // 映像
    const video = $('#bg-video');
    if (this.song.videoUrl) {
      video.src = this.song.videoUrl;
      video.classList.remove('hidden');
      $('#bg-fallback').classList.add('hidden');
      video.load();
    } else {
      video.removeAttribute('src');
      video.classList.add('hidden');
      $('#bg-fallback').classList.remove('hidden');
    }

    $('#stage-placeholder').classList.remove('hidden');
    this.state = 'ready';
    this._updateStats();
    this._syncPlayButton();
    return this.song;
  }

  notes() { return this.song ? this.song.notes : []; }

  // ------------------------------------------------------------------
  //  再生制御
  // ------------------------------------------------------------------
  async start() {
    if (!this.song) { toast('先に曲を選択してください'); return; }
    await this.engine.init();

    if (this.settings.autoMic && !this.micOn) await this.enableMic(true);

    this.scorer.reset();
    this.scorer.enabled = this.micOn;
    this.lane.trailFrozen = false;
    this.engine.play(0);
    $('#stage-placeholder').classList.add('hidden');
    this._playVideo(true);
    this.state = 'playing';
    this._syncPlayButton();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this._loop);
  }

  async toggle() {
    if (!this.song) return;
    if (this.state === 'playing') await this.pause();
    else if (this.state === 'ended') await this.start();
    else await this.resume();
  }

  async resume() {
    if (!this.song) return;
    await this.engine.init();
    this.engine.play(this.engine.pausedAt);
    $('#stage-placeholder').classList.add('hidden');
    this._playVideo(true);
    this.state = 'playing';
    this.scorer.enabled = this.micOn;
    this._syncPlayButton();
    cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(this._loop);
  }

  async pause() {
    this.engine.pause();
    const v = document.getElementById('bg-video');
    if (v) v.pause();
    this.state = 'paused';
    this._syncPlayButton();
  }

  async stopAll() {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.engine.stop();
    const v = document.getElementById('bg-video');
    if (v) { v.pause(); try { v.currentTime = 0; } catch (e) { /* */ } }
    if (this.state !== 'idle') this.state = 'ready';
    this._syncPlayButton();
  }

  async seek(t, keepScore = true) {
    const n = Number(t);
    const target = Number.isFinite(n) ? clamp(n, 0, this.engine.duration || 0) : 0;
    const wasPlaying = this.state === 'playing';
    await this.engine.seek(target);
    if (this.scorer) {
      if (keepScore) this.scorer.resetTo(target);
      else this.scorer.reset();
    }
    const v = document.getElementById('bg-video');
    if (v) { try { v.currentTime = target; } catch (e) { /* */ } }
    if (!wasPlaying) {
      this.lyrics.update(target);
      this.lane.render(target, { offset: this.engine.pitchOffsetSemis, detected: null, micOn: this.micOn });
      this._updateTimeUI(target);
    }
  }

  finish() {
    if (this.state === 'ended') return;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.engine.pause();
    const v = document.getElementById('bg-video');
    if (v) v.pause();
    this.state = 'ended';
    this._syncPlayButton();

    if (!this.scorer) return;
    this.scorer.finalize();
    const res = this.scorer.result();
    this.lastResult = res;

    if (this.song && this.song.id && this.scorer.enabled && res.score > 0) {
      addHighscore(this.song.id, res);
      const best = bestScore(this.song.id);
      $('#p-best').textContent = `ベストスコア: ${best.score.toLocaleString()} (${best.accuracy}%)`;
    }
    this.showResult();
  }

  // ------------------------------------------------------------------
  //  同期ループ（心臓部）
  // ------------------------------------------------------------------
  _loop() {
    this.rafId = requestAnimationFrame(this._loop);
    const engine = this.engine;
    const t = engine.time;
    const dur = engine.duration;

    // 1) 歌詞ワイプ
    this.lyrics.update(t);

    // 2) 映像の同期（ずれが 80ms を超えたら補正） / 映像が無ければ背景アニメ
    if (this.song && !this.song.videoUrl) this._drawFallbackBg(t);
    this._syncVideo(t);

    // 3) マイク解析 → 採点
    let detected = null;
    if (this.micOn) {
      detected = engine.getPitch();
      if (detected.level > 0.012) {
        $('#mic-level').style.width = `${clamp(detected.level * 450, 0, 100)}%`;
      } else {
        $('#mic-level').style.width = '0%';
      }
    }
    if (this.scorer) {
      this.scorer.setOffset(engine.pitchOffsetSemis);
      this.scorer.update(t, detected ? detected.midi : null);
    }

    // 4) 音程バー
    this.lane.render(t, {
      offset: engine.pitchOffsetSemis,
      detected,
      micOn: this.micOn,
    });

    // 5) HUD
    this._updateTimeUI(t);
    this._updateHud();

    // 6) 終端
    if (t >= dur - 0.02 && this.state === 'playing') {
      this.finish();
    }
  }

  _syncVideo(t) {
    const v = document.getElementById('bg-video');
    if (!v || v.classList.contains('hidden') || !v.duration || !isFinite(v.duration)) return;
    const speed = this.engine.speed;
    if (Math.abs(v.playbackRate - speed) > 0.01) {
      try { v.playbackRate = speed; } catch (e) { /* */ }
    }
    let target = t;
    if (t > v.duration) target = v.duration > 0.5 ? t % v.duration : v.duration; // 短い映像はループ
    if (!v.seeking && Math.abs(v.currentTime - target) > 0.08) {
      try { v.currentTime = target; } catch (e) { /* */ }
    }
  }

  _playVideo(on) {
    const v = document.getElementById('bg-video');
    if (!v || v.classList.contains('hidden')) return;
    if (on) v.play().catch(() => { /* ユーザー操作待ち */ });
    else v.pause();
  }

  _updateTimeUI(t) {
    $('#time-cur').textContent = formatTime(t);
    const dur = this.engine.duration || 1;
    $('#progress-fill').style.width = `${clamp((t / dur) * 100, 0, 100)}%`;
  }

  _updateHud() {
    if (!this.scorer) return;
    const l = this.scorer.live;
    setText('#hud-score', l.score.toLocaleString());
    setText('#hud-combo', String(l.combo));
    setText('#hud-acc', l.accuracy.voiced ? `${Math.round(l.accuracy.ratio * 100)}%` : '--%');
    setText('#st-perfect', String(l.perfect));
    setText('#st-good', String(l.good));
    setText('#st-miss', String(l.miss));
    setText('#st-combo', String(l.maxCombo));
    setText('#st-score', l.score.toLocaleString());
  }

  _updateStats() {
    this._updateHud();
    setText('#hud-score', '0');
    setText('#hud-combo', '0');
    setText('#hud-acc', '--%');
  }

  _syncPlayButton() {
    const btn = $('#btn-play');
    if (!btn) return;
    btn.textContent = this.state === 'playing' ? '⏸' : '▶';
    const ed = document.getElementById('ed-play');
    if (ed) ed.textContent = this.state === 'playing' ? '⏸' : '▶';
  }

  _showJudge(judgment, combo) {
    const el = $('#judgment');
    if (!el) return;
    const label = judgment === 'perfect' ? 'PERFECT' : judgment === 'good' ? 'GOOD' : 'MISS';
    el.textContent = combo > 1 && judgment !== 'miss' ? `${label}  ×${combo}` : label;
    el.className = `judgment show ${judgment}`;
    // アニメーションを再実行
    void el.offsetWidth;
    if (this.scorer) this._updateHud();
  }

  // ------------------------------------------------------------------
  //  マイク / 録音
  // ------------------------------------------------------------------
  async enableMic(auto = false) {
    const ok = await this.engine.enableMic();
    this.micOn = ok;
    if (this.scorer) this.scorer.enabled = ok && this.state === 'playing';
    const btn = $('#btn-mic');
    const st = $('#mic-status');
    if (ok) {
      btn.textContent = '🎤 マイク停止';
      btn.classList.add('on');
      st.textContent = `接続中 (${this.engine.sampleRate}Hz) — 歌い出しが判定されます`;
      st.className = 'small ok';
      if (!auto) toast('マイクを接続しました');
    } else {
      btn.textContent = '🎤 マイク開始';
      btn.classList.remove('on');
      st.textContent = `接続失敗: ${this.engine.micError || '不明なエラー'}`;
      st.className = 'small err';
      if (!auto) toast('マイクを接続できませんでした', 'err');
    }
    return ok;
  }

  disableMic() {
    this.engine.disableMic();
    this.micOn = false;
    if (this.scorer) this.scorer.enabled = false;
    $('#btn-mic').textContent = '🎤 マイク開始';
    $('#btn-mic').classList.remove('on');
    $('#mic-status').textContent = '未接続';
    $('#mic-status').className = 'small dim';
    $('#mic-level').style.width = '0%';
  }

  async toggleRec() {
    const btn = $('#btn-rec');
    const stopBtn = $('#btn-rec-stop');
    try {
      if (this.engine.recording) {
        const out = await this.engine.stopRecording();
        stopBtn.disabled = true;
        btn.disabled = false;
        btn.textContent = '⏺ 録音開始';
        if (out) this._addRecording(out);
        return;
      }
      await this.engine.init();
      this.engine.startRecording();
      stopBtn.disabled = false;
      btn.disabled = true;
      btn.textContent = '⏺ 録音中…';
      toast('録音を開始しました');
    } catch (e) {
      toast(`録音できません: ${e.message}`, 'err');
      btn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  _addRecording({ blob, ext }) {
    const item = { blob, ext, at: new Date() };
    this.recordings.unshift(item);
    const list = $('#rec-list');
    const row = document.createElement('div');
    row.className = 'rec-item';
    const time = item.at.toLocaleTimeString();
    row.innerHTML = `
      <span class="rec-time">${time}</span>
      <audio controls src="${URL.createObjectURL(blob)}"></audio>
      <button class="btn tiny">⬇</button>`;
    row.querySelector('button').onclick = () => {
      const name = `${(this.song && this.song.info.title) || 'song'}_rec_${Date.now()}.${ext}`;
      download(blob, name);
    };
    list.prepend(row);
    toast('録音が完了しました');
    if (this.lastResult) $('#rs-dl').classList.remove('hidden');
    this._lastRecording = blob;
  }

  // ------------------------------------------------------------------
  //  リザルト
  // ------------------------------------------------------------------
  showResult() {
    const res = this.lastResult;
    if (!res) { toast('まだプレイ結果がありません'); return; }
    const info = (this.song && this.song.info) || {};
    setText('#rs-song', `${info.title || '無題'}${info.artist ? ' / ' + info.artist : ''}`);
    animateNumber($('#rs-score'), res.score);
    setText('#rs-perfect', String(res.perfect));
    setText('#rs-good', String(res.good));
    setText('#rs-miss', String(res.miss));
    setText('#rs-combo', String(res.maxCombo));
    setText('#rs-acc', `${res.accuracy}%`);

    const best = this.song && this.song.id ? bestScore(this.song.id) : null;
    setText('#rs-best', best ? best.score.toLocaleString() : '—');

    const notes = $('#rs-note');
    if (!this.micOn) {
      notes.textContent = '※ マイク未接続のため実際の採点は行われていません。マイクを有効にしてください。';
    } else if (res.meanErr > 0) {
      notes.textContent = `平均音程誤差: ${res.meanErr} 半音 / 判定したノート: ${res.total} 個`;
    } else {
      notes.textContent = `判定したノート: ${res.total} 個`;
    }

    $('#rs-dl').classList.toggle('hidden', !this._lastRecording);
    $('#result-modal').classList.remove('hidden');
    requestAnimationFrame(() => this._drawResultCharts(res));
  }

  _drawResultCharts(res) {
    drawLineChart($('#rs-chart-lines'), res.lineScores || []);
    drawPitchChart($('#rs-chart-pitch'), res);
  }

  // ------------------------------------------------------------------
  //  UI バインド
  // ------------------------------------------------------------------
  _bindUI() {
    $('#btn-start').onclick = () => this.start();
    $('#btn-play').onclick = () => this.toggle();
    $('#btn-stop').onclick = async () => { await this.stopAll(); this.lyrics.update(0); this.lane.render(0, { offset: this.engine.pitchOffsetSemis, detected: null, micOn: this.micOn }); this._updateTimeUI(0); if (this.scorer) { this.scorer.reset(); this._updateHud(); } $('#stage-placeholder').classList.remove('hidden'); };
    $('#btn-end').onclick = () => { if (this.state === 'playing' || this.state === 'paused') this.finish(); };

    $('#progress').onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const ratio = clamp((e.clientX - r.left) / r.width, 0, 1);
      this.seek(ratio * this.engine.duration);
    };

    // キー変更
    const setKey = (v) => {
      this.engine.setTranspose(v);
      $('#key-val').textContent = (this.engine.transpose > 0 ? '+' : '') + this.engine.transpose;
      if (this.scorer) this.scorer.setOffset(this.engine.pitchOffsetSemis);
      if (this.state !== 'playing') this.lane.render(this.engine.time, { offset: this.engine.pitchOffsetSemis, detected: null, micOn: this.micOn });
    };
    $('#key-minus').onclick = () => setKey(this.engine.transpose - 1);
    $('#key-plus').onclick = () => setKey(this.engine.transpose + 1);
    $('#key-reset').onclick = () => setKey(0);

    // スピード
    $('#speed').oninput = (e) => {
      const v = Number(e.target.value);
      $('#speed-val').textContent = v.toFixed(2);
      this.engine.setSpeed(v);
    };
    $('#chk-pitch-fix').onchange = (e) => {
      this.engine.setPitchFix(e.target.checked);
      if (this.scorer) this.scorer.setOffset(this.engine.pitchOffsetSemis);
      toast(e.target.checked ? '速度変更でもキーを保ちます' : 'テープ式: スピードに合わせてキーも動きます');
    };

    // エコー
    $('#echo').oninput = (e) => {
      $('#echo-val').textContent = e.target.value;
      this.engine.setEcho(Number(e.target.value));
    };

    // マイク
    $('#btn-mic').onclick = () => { this.micOn ? this.disableMic() : this.enableMic(); };
    $('#btn-monitor').onclick = (e) => {
      const on = !this.engine.monitor;
      this.engine.setMonitor(on);
      e.currentTarget.textContent = on ? '監視ON' : '監視OFF';
      e.currentTarget.classList.toggle('on', on);
    };

    // 録音
    $('#btn-rec').onclick = () => this.toggleRec();
    $('#btn-rec-stop').onclick = () => this.toggleRec();

    // リザルト
    $('#rs-retry').onclick = async () => { $('#result-modal').classList.add('hidden'); await this.start(); };
    $('#rs-back').onclick = () => { $('#result-modal').classList.add('hidden'); document.querySelector('[data-route="library"]').click(); };
    $('#rs-dl').onclick = () => {
      if (this._lastRecording) download(this._lastRecording, `${(this.song && this.song.info.title) || 'song'}_rec.${this.recordings[0] ? this.recordings[0].ext : 'webm'}`);
    };

    // 背景フォールバックの描画
    this._drawFallbackBg = this._drawFallbackBg.bind(this);
  }

  _drawIdleLane() {
    this.lane.render(0, { offset: 0, detected: null, micOn: false });
  }

  /** 映像が無いときの背景アニメーション */
  _drawFallbackBg(t) {
    const c = document.getElementById('bg-fallback');
    if (!c || c.classList.contains('hidden')) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, w, h);
    const p = (t || performance.now() / 1000) * 0.08;
    g.addColorStop(0, `hsl(${(210 + Math.sin(p) * 30 + 360) % 360} 45% 18%)`);
    g.addColorStop(0.5, `hsl(${(265 + Math.sin(p * 0.7 + 1) * 40 + 360) % 360} 50% 26%)`);
    g.addColorStop(1, `hsl(${(190 + Math.sin(p * 0.5 + 2) * 30 + 360) % 360} 55% 14%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3; i++) {
      const x = w * (0.2 + 0.3 * i) + Math.sin(p * (1 + i * 0.3) + i) * w * 0.12;
      const y = h * (0.35 + 0.18 * ((i % 2) ? 1 : -1)) + Math.cos(p * (0.8 + i * 0.2) + i) * h * 0.16;
      const r = Math.min(w, h) * (0.24 + 0.05 * i);
      const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `rgba(255,255,255,${0.06 + 0.03 * Math.sin(p * 2 + i)})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------------
//  ヘルパ
// ---------------------------------------------------------------------
function setText(sel, text) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el && el.textContent !== text) el.textContent = text;
}

function animateNumber(el, target) {
  if (!el) return;
  const start = performance.now();
  const dur = 900;
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(target * eased).toLocaleString();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function setupCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 400;
  const h = Number(canvas.getAttribute('height')) || 150;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawLineChart(canvas, rows) {
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 30, r: 8, t: 12, b: 34 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(pad.l, pad.t, iw, ih);

  // 目盛
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let p = 0; p <= 100; p += 25) {
    const y = pad.t + ih - (p / 100) * ih;
    ctx.beginPath();
    ctx.moveTo(pad.l, y + 0.5);
    ctx.lineTo(pad.l + iw, y + 0.5);
    ctx.stroke();
    ctx.fillText(`${p}`, pad.l - 5, y);
  }

  if (!rows.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('データがありません', w / 2, h / 2);
    return;
  }

  const bw = Math.max(4, iw / rows.length - 6);
  rows.forEach((r, i) => {
    const x = pad.l + (iw / rows.length) * i + 3;
    const ratio = clamp(r.ratio, 0, 1);
    const bh = ratio * ih;
    const y = pad.t + ih - bh;
    const color = ratio >= 0.72 ? '#5be9b0' : ratio >= 0.4 ? '#ffd166' : '#ff5d8f';
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(x, y, bw, bh);
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x + bw / 2, pad.t + ih + 6);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.rotate(-Math.PI / 5);
    const label = (r.text || `${i + 1}`).slice(0, 10);
    ctx.fillText(label, 0, 0);
    ctx.restore();
  });
}

function drawPitchChart(canvas, res) {
  const { ctx, w, h } = setupCanvas(canvas);
  const pad = { l: 30, r: 8, t: 12, b: 20 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const trail = (res.trail || []).filter((p) => p.t != null);
  const dur = res.notes && res.notes.length
    ? Math.max(1, res.notes[res.notes.length - 1].start + res.notes[res.notes.length - 1].dur)
    : 1;

  const RANGE = 3; // ±3半音
  const yOf = (err) => pad.t + ih / 2 - (clamp(err, -RANGE, RANGE) / RANGE) * (ih / 2);

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(pad.l, pad.t, iw, ih);

  // バンド
  ctx.fillStyle = 'rgba(91,233,176,0.14)';
  ctx.fillRect(pad.l, yOf(0.55), iw, yOf(-0.55) - yOf(0.55));
  ctx.fillStyle = 'rgba(255,209,102,0.10)';
  ctx.fillRect(pad.l, yOf(1.5), iw, yOf(0.55) - yOf(1.5));
  ctx.fillRect(pad.l, yOf(-0.55), iw, yOf(-1.5) - yOf(-0.55));

  // 中央線と目盛
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(pad.l, yOf(0) + 0.5);
  ctx.lineTo(pad.l + iw, yOf(0) + 0.5);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText('0', pad.l - 5, yOf(0));
  ctx.fillText('+3', pad.l - 5, yOf(3));
  ctx.fillText('-3', pad.l - 5, yOf(-3));

  if (!trail.length) {
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'center';
    ctx.fillText('音程データがありません', w / 2, h / 2);
    return;
  }

  for (const p of trail) {
    if (p.err == null) continue;
    const x = pad.l + (p.t / dur) * iw;
    const y = yOf(p.err);
    const a = Math.abs(p.err);
    ctx.fillStyle = a <= 0.55 ? 'rgba(91,233,176,0.85)' : a <= 1.5 ? 'rgba(255,209,102,0.85)' : 'rgba(255,93,143,0.8)';
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('時間 →', pad.l + 4, pad.t + ih - 2);
}
