// editor.js — KSGメーカー（作る / 編集する）
//   ・音声 / 映像 / .ksg の取り込み
//   ・波形 + ピアノロールでの音程編集
//   ・歌詞行とタイムスタンプ / 音節の編集
//   ・ライブラリ保存 と .ksg 書き出し
//
import { $, $$, clamp, formatTime1, toast, pickFile, download, uid } from './util.js';
import { AudioEngine } from './audio-engine.js';
import { Waveform } from './waveform.js';
import { PianoRoll } from './piano-roll.js';
import { writeMidi, parseMidi } from './midi.js';
import { buildKsg, readKsg, ksgFileName } from './ksg.js';
import { putSong } from './store.js';
import { splitSyllables } from './lyrics-view.js';

function newProject() {
  return {
    id: null,
    info: { title: '', artist: '', bpm: 120, key: 0, offset: 0, duration: 0 },
    audioBlob: null, audioName: null,
    videoBlob: null, videoName: null,
    notes: [],
    lines: [],
    dirty: false,
  };
}

export class Editor {
  constructor() {
    this.project = newProject();
    this.engine = new AudioEngine();
    this.selectedNote = null;
    this.selectedLine = -1;
    this.playing = false;
    this.view = { scrollT: 0, pps: 110, gutter: 34, pxPerMidi: 13, topMidi: 84, snap: 1 };

    this.waveform = new Waveform($('#ed-waveform'));
    this.roll = new PianoRoll($('#ed-pianoroll'), {
      getView: () => this.view,
      getNotes: () => this.project.notes,
      getSelected: () => this.selectedNote,
      setSelected: (n) => { this.selectedNote = n; this.updateNoteProps(); },
      onSelectChanged: () => this.updateNoteProps(),
      onSeek: (t) => this.seek(t),
      onChange: () => { this.project.dirty = true; this.roll.draw(); },
      snap: (t) => this.snap(t),
      getTime: () => this.engine.time || 0,
      getBpm: () => Number($('#ed-bpm').value) || 120,
    });

    this._loop = this._loop.bind(this);
    this._bindUI();
    this.renderLyrics();
    this.updateNoteProps();
    this._syncFields();
  }

  // ------------------------------------------------------------------
  //  プロジェクト操作
  // ------------------------------------------------------------------
  resetProject(msg) {
    this.stop();
    this.project = newProject();
    this.selectedNote = null;
    this.selectedLine = -1;
    this.engine.stop();
    this.engine.buffer = null;
    this.waveform.setBuffer(null);
    this.roll.draw();
    this.renderLyrics();
    this.updateNoteProps();
    this._syncFields();
    if (msg) toast(msg);
  }

  _syncFields() {
    $('#ed-title').value = this.project.info.title || '';
    $('#ed-artist').value = this.project.info.artist || '';
    $('#ed-bpm').value = this.project.info.bpm || 120;
    $('#ed-offset').value = this.project.info.offset || 0;
    $('#ed-time').textContent = '0:00.0';
  }

  _readFields() {
    this.project.info.title = $('#ed-title').value.trim();
    this.project.info.artist = $('#ed-artist').value.trim();
    this.project.info.bpm = Number($('#ed-bpm').value) || 120;
    this.project.info.offset = Number($('#ed-offset').value) || 0;
    this.roll.draw();
  }

  async _ensureEngine() {
    await this.engine.init();
    return this.engine;
  }

  /** 音声ファイルを取り込む */
  async importAudio(file) {
    if (!file) return;
    await this._ensureEngine();
    const ab = await file.arrayBuffer();
    const buf = await this.engine.load(ab);
    this.project.audioBlob = file;
    this.project.audioName = normalizeAudioName(file.name);
    this.project.info.duration = buf.duration;
    this.waveform.setBuffer(buf);
    this.project.dirty = true;
    if (!this.project.info.title) {
      this.project.info.title = file.name.replace(/\.[^.]+$/, '');
      $('#ed-title').value = this.project.info.title;
    }
    toast(`音源を読み込みました (${buf.duration.toFixed(1)}秒)`);
    this.roll.draw();
  }

  /** 映像ファイルを取り込む */
  async importVideo(file) {
    if (!file) return;
    this.project.videoBlob = file;
    this.project.videoName = normalizeVideoName(file.name);
    this.project.dirty = true;
    toast(`映像を読み込みました: ${file.name}`);
  }

  /** MIDI (.mid) を読み込んでノート / BPM / 歌詞イベントを取り込む */
  async importMidi(file) {
    if (!file) return;
    let parsed;
    try {
      parsed = parseMidi(await file.arrayBuffer());
    } catch (e) {
      console.error(e);
      toast(`MIDI を読み込めませんでした: ${e.message}`, 'err');
      return;
    }
    const notes = (parsed && parsed.notes) || [];
    if (!notes.length) { toast('MIDI にノートがありません', 'err'); return; }

    const replaced = this.project.notes.length;
    this.project.notes = notes.map((n, i) => ({
      id: `m${i}_${Math.random().toString(36).slice(2, 6)}`,
      midi: n.midi,
      start: round2(n.start),
      dur: round2(Math.max(0.03, n.dur)),
    }));

    if (parsed.bpm > 0) {
      this.project.info.bpm = Math.round(parsed.bpm * 100) / 100;
      $('#ed-bpm').value = this.project.info.bpm;
    }

    // 歌詞メタイベント（Lyric）があれば、歌詞行が空のときだけ行へ整形
    let lyricInfo = '';
    const lyricEvents = (parsed.lyrics || []).filter((l) => l && String(l.text || '').length);
    if (lyricEvents.length && !this.project.lines.length) {
      this.project.lines = linesFromLyricEvents(lyricEvents);
      lyricInfo = ` / 歌詞 ${this.project.lines.length}行`;
    }

    const last = notes[notes.length - 1];
    if (last && last.start + last.dur > this.project.info.duration) {
      this.project.info.duration = round2(last.start + last.dur);
    }

    this.selectedNote = this.project.notes[0];
    this.project.dirty = true;
    this.updateNoteProps();
    this.renderLyrics();
    this.roll.draw();
    toast(`MIDI を読み込みました（${notes.length}ノート${replaced ? ' / 既存を置換' : ''}${lyricInfo}・${parsed.bpm} BPM）`);
  }

  /** .ksg を開いて編集対象にする */
  async openKsg(file, id = null) {
    if (!file) return;
    toast('.ksg を読み込み中…');
    const data = await readKsg(file);
    await this._applyParts(data, id);
  }

  /** ライブラリのレコードを編集対象にする */
  async loadRecord(rec) {
    await this._applyParts({
      info: rec.info,
      lyrics: rec.lyrics,
      notes: (rec.notes && rec.notes.length) ? rec.notes : (rec.midi ? parseMidi(rec.midi).notes : []),
      midiBuffer: rec.midi,
      audioBlob: rec.audioBlob,
      audioName: rec.audioName,
      videoBlob: rec.videoBlob,
      videoName: rec.videoName,
    }, rec.id);
  }

  async _applyParts(data, id = null) {
    this.stop();
    this.project = {
      id: id || null,
      info: {
        title: data.info.title || '',
        artist: data.info.artist || '',
        bpm: data.info.bpm || 120,
        key: data.info.key || 0,
        offset: data.info.offset || 0,
        duration: data.info.duration || 0,
      },
      audioBlob: data.audioBlob,
      audioName: data.audioName,
      videoBlob: data.videoBlob,
      videoName: data.videoName,
      notes: (data.notes || []).map((n, i) => ({ id: `m${i}_${Math.random().toString(36).slice(2, 6)}`, midi: n.midi, start: n.start, dur: n.dur })),
      lines: ((data.lyrics && data.lyrics.lines) || []).map((l) => ({
        id: uid(),
        text: l.text || '',
        start: l.start || 0,
        end: l.end || 0,
        syllables: (l.syllables || []).map((s) => ({ ...s })),
      })),
      dirty: false,
    };

    await this._ensureEngine();
    const buf = await this.engine.load(await data.audioBlob.arrayBuffer());
    this.project.info.duration = buf.duration;
    this.waveform.setBuffer(buf);
    this.selectedNote = null;
    this.selectedLine = -1;
    this.view.scrollT = 0;
    this._syncFields();
    this.renderLyrics();
    this.updateNoteProps();
    this.roll.draw();
    toast(`「${this.project.info.title}」を開きました（${this.project.notes.length}ノート / ${this.project.lines.length}行）`);
  }

  /** ライブラリ (IndexedDB) に保存 */
  async saveToLibrary() {
    this._readFields();
    if (!this.project.audioBlob) { toast('先に音源を読み込んでください', 'err'); return null; }
    if (!this.project.info.title) { toast('曲名を入力してください', 'err'); return null; }

    const info = { ...this.project.info, duration: this.engine.duration || this.project.info.duration };
    const { midi, lyrics, notes } = this._buildExportData();
    const id = await putSong({
      id: this.project.id || undefined,
      info,
      lyrics,
      midi,
      notes,
      audioBlob: this.project.audioBlob,
      audioName: this.project.audioName,
      videoBlob: this.project.videoBlob,
      videoName: this.project.videoName,
    });
    this.project.id = id;
    this.project.dirty = false;
    toast('ライブラリに保存しました');
    if (this.onSaved) this.onSaved();
    return id;
  }

  /** .ksg をエクスポート（ローカルへダウンロード） */
  async exportKsg() {
    this._readFields();
    if (!this.project.audioBlob) { toast('先に音源を読み込んでください', 'err'); return; }
    const info = { ...this.project.info, duration: this.engine.duration || this.project.info.duration };
    const { midi, lyrics, notes } = this._buildExportData();
    toast('.ksg をパッケージ中…');
    const blob = await buildKsg({ info, lyrics, midi, notes, audioBlob: this.project.audioBlob, audioName: this.project.audioName, videoBlob: this.project.videoBlob, videoName: this.project.videoName });
    download(blob, ksgFileName(info));
    toast(`書き出しました (${(blob.size / 1024 / 1024).toFixed(2)}MB)`);
  }

  _buildExportData() {
    const bpm = Number($('#ed-bpm').value) || 120;
    const lyrics = {
      version: 1,
      lines: this.project.lines.map((l) => ({
        text: l.text,
        start: round2(l.start),
        end: round2(l.end),
        syllables: (l.syllables || []).map((s) => ({ text: s.text, start: round2(s.start), end: round2(s.end) })),
      })),
    };
    const midiEvents = [];
    for (const l of this.project.lines) {
      midiEvents.push({ time: l.start, text: l.text });
      for (const s of l.syllables || []) midiEvents.push({ time: s.start, text: s.text });
    }
    const midi = writeMidi(this.project.notes.map((n) => ({ start: n.start, dur: n.dur, midi: n.midi })), {
      bpm,
      lyrics: midiEvents,
      program: 0,
    });
    return {
      midi,
      lyrics,
      notes: this.project.notes.map((n) => ({ midi: n.midi, start: round2(n.start), dur: round2(n.dur) })),
    };
  }

  // ------------------------------------------------------------------
  //  プレビュー再生
  // ------------------------------------------------------------------
  snap(t) {
    const snapVal = Number($('#ed-snap').value);
    if (!snapVal) return t;
    const beat = 60 / (Number($('#ed-bpm').value) || 120);
    const grid = beat * snapVal;
    return Math.round(t / grid) * grid;
  }

  async play() {
    if (!this.engine.buffer) { toast('先に音源を読み込んでください'); return; }
    await this._ensureEngine();
    if (this.engine.playing) {
      this.engine.pause();
      this.playing = false;
      cancelAnimationFrame(this._raf);
      $('#ed-play').textContent = '▶';
      this.roll.draw();
      return;
    }
    const from = this.engine.pausedAt >= this.engine.duration ? 0 : this.engine.pausedAt;
    await this.engine.play(from);
    this.playing = true;
    $('#ed-play').textContent = '⏸';
    this.roll.follow = true;
    cancelAnimationFrame(this._raf);
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    this.engine.stop();
    this.playing = false;
    cancelAnimationFrame(this._raf);
    $('#ed-play').textContent = '▶';
    this.roll.draw();
    this._updateTimeUI(0);
  }

  seek(t) {
    const target = clamp(t, 0, this.engine.duration || 1e9);
    if (this.engine.playing) this.engine.seek(target);
    else this.engine.pausedAt = target;
    this._updateTimeUI(target);
    this._updateHead(target);
    this.roll.draw();
  }

  _loop() {
    if (!this.playing) return;
    this._raf = requestAnimationFrame(this._loop);
    const t = this.engine.time;
    this._updateTimeUI(t);
    this._updateHead(t);
    if (this.roll.autoFollow(t)) this.waveform.draw(this.view);
    this.roll.draw();
    if (t >= this.engine.duration - 0.02) this.stop();
  }

  _updateTimeUI(t) { $('#ed-time').textContent = formatTime1(t); }

  _updateHead(t) {
    const head = $('#ed-wave-head');
    if (!head) return;
    const x = this.view.gutter + (t - this.view.scrollT) * this.view.pps;
    const w = $('#ed-waveform').clientWidth;
    if (x < this.view.gutter || x > w) { head.classList.add('hidden'); return; }
    head.classList.remove('hidden');
    head.style.left = `${x}px`;
  }

  // ------------------------------------------------------------------
  //  歌詞パネル
  // ------------------------------------------------------------------
  renderLyrics() {
    const box = $('#lp-lines');
    box.innerHTML = '';
    const lines = this.project.lines;

    if (!lines.length) {
      box.innerHTML = '<div class="lp-empty dim">行がありません。「＋ 行」で追加するか、.ksg を開いてください。</div>';
      return;
    }

    lines.forEach((ln, i) => {
      const row = document.createElement('div');
      row.className = 'lp-row' + (i === this.selectedLine ? ' selected' : '');
      row.innerHTML = `
        <input class="lp-text" type="text" value="${escapeAttr(ln.text)}" placeholder="歌詞テキスト">
        <div class="lp-times">
          <label>始<input class="lp-start" type="number" step="0.01" value="${round2(ln.start)}"></label>
          <label>終<input class="lp-end" type="number" step="0.01" value="${round2(ln.end)}"></label>
          <button class="btn tiny" title="再生位置を行の開始に">⏱</button>
          <button class="btn tiny danger" title="この行を削除">✕</button>
        </div>
        <div class="lp-syl dim">${(ln.syllables || []).length ? `${ln.syllables.length} 音節` : '音節なし（行全体ワイプ）'}</div>`;

      row.querySelector('.lp-text').oninput = (e) => { ln.text = e.target.value; this.project.dirty = true; };
      row.querySelector('.lp-text').onfocus = () => this._selectLine(i);
      row.querySelector('.lp-start').onchange = (e) => { ln.start = Number(e.target.value) || 0; this.project.dirty = true; this.roll.draw(); };
      row.querySelector('.lp-end').onchange = (e) => { ln.end = Number(e.target.value) || 0; this.project.dirty = true; this.roll.draw(); };
      row.querySelectorAll('.btn')[0].onclick = () => {
        ln.start = this.engine.time || 0;
        row.querySelector('.lp-start').value = round2(ln.start);
        this.project.dirty = true;
        this._selectLine(i);
      };
      row.querySelectorAll('.btn')[1].onclick = () => {
        this.project.lines.splice(i, 1);
        if (this.selectedLine === i) this.selectedLine = -1;
        this.renderLyrics();
        this.project.dirty = true;
      };
      row.addEventListener('click', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        this._selectLine(i);
        this.seek(ln.start);
      });
      box.appendChild(row);
    });
  }

  _selectLine(i) {
    this.selectedLine = i;
    $$('.lp-row').forEach((r, k) => r.classList.toggle('selected', k === i));
  }

  addLine() {
    const t = this.engine.time || 0;
    const prev = this.project.lines[this.project.lines.length - 1];
    const start = prev && prev.end > prev.start ? Math.max(prev.end + 0.2, t) : t;
    this.project.lines.push({ id: uid(), text: '', start: round2(start), end: round2(start + 3), syllables: [] });
    this.selectedLine = this.project.lines.length - 1;
    this.renderLyrics();
    this.project.dirty = true;
    const box = $('#lp-lines');
    box.scrollTop = box.scrollHeight;
  }

  /** 選択行を文字単位の音節へ自動分割 */
  autoSplit() {
    const ln = this.project.lines[this.selectedLine];
    if (!ln) { toast('先に歌詞行を選択してください', 'err'); return; }
    if (!(ln.end > ln.start)) { toast('行の開始/終了が不正です', 'err'); return; }
    ln.syllables = splitSyllables(ln);
    this.renderLyrics();
    this._selectLine(this.selectedLine);
    this.project.dirty = true;
    toast(`${ln.syllables.length} 音節に分割しました`);
  }

  /** 選択行の音節を選択中のノート（メロディ）へ整列 */
  alignToNotes() {
    const ln = this.project.lines[this.selectedLine];
    if (!ln) { toast('先に歌詞行を選択してください', 'err'); return; }

    let range = this.project.notes.filter((n) => n.start >= ln.start - 0.5 && n.start <= ln.end + 0.5);
    if (!range.length) {
      // 行範囲が空なら再生位置の近くから拾う
      const t = this.engine.time || 0;
      range = this.project.notes.filter((n) => n.start >= t && n.start < t + 8);
    }
    if (!range.length) { toast('範囲内のノートがありません', 'err'); return; }
    range.sort((a, b) => a.start - b.start);

    if (!ln.syllables || !ln.syllables.length) ln.syllables = splitSyllables(ln);
    const syl = ln.syllables;
    if (!syl.length) { toast('文字がありません', 'err'); return; }

    const nNotes = range.length;
    const nSyl = syl.length;
    syl.forEach((s, i) => {
      if (nSyl === nNotes) {
        s.start = range[i].start;
        s.end = i + 1 < nNotes ? range[i + 1].start : range[i].start + range[i].dur;
      } else {
        // 比例配分
        const first = range[0].start;
        const last = range[nNotes - 1].start + range[nNotes - 1].dur;
        const step = (last - first) / nSyl;
        s.start = first + step * i;
        s.end = first + step * (i + 1);
      }
      s.start = round2(s.start);
      s.end = round2(s.end);
    });

    ln.start = round2(range[0].start);
    ln.end = round2(range[nNotes - 1].start + range[nNotes - 1].dur);
    this.renderLyrics();
    this._selectLine(this.selectedLine);
    this.project.dirty = true;
    toast(`ノート ${nNotes} 個に整列しました`);
  }

  // ------------------------------------------------------------------
  //  選択ノートのプロパティ
  // ------------------------------------------------------------------
  updateNoteProps() {
    const box = $('#note-props');
    const n = this.selectedNote;
    if (!n || this.project.notes.indexOf(n) < 0) {
      box.className = 'note-props dim';
      box.innerHTML = 'ノート未選択（クリックで選択 / 右クリックで削除）';
      return;
    }
    box.className = 'note-props';
    box.innerHTML = `
      <div class="np-row">
        <label>音高<input id="np-midi" type="number" min="0" max="127" value="${n.midi}"></label>
        <label>開始<input id="np-start" type="number" step="0.01" value="${round2(n.start)}"></label>
        <label>長さ<input id="np-dur" type="number" step="0.01" min="0.02" value="${round2(n.dur)}"></label>
        <button id="np-del" class="btn tiny danger">削除</button>
      </div>
      <div class="np-row">
        <button id="np-len-minus" class="btn tiny" title="1グリッド短く ([)">− 長さ</button>
        <button id="np-len-plus" class="btn tiny" title="1グリッド長く (])">＋ 長さ</button>
        <button id="np-syl" class="btn tiny">ここを音節開始に</button>
      </div>
      <div class="np-row">
        <span id="np-name" class="dim">${noteName(n.midi)}</span>
      </div>`;

    $('#np-midi').onchange = (e) => { n.midi = clamp(Math.round(Number(e.target.value) || 0), 0, 127); this.roll.draw(); this.updateNoteProps(); this.project.dirty = true; };
    $('#np-start').onchange = (e) => { n.start = Math.max(0, Number(e.target.value) || 0); this.roll.draw(); this.project.dirty = true; };
    $('#np-dur').onchange = (e) => { n.dur = Math.max(0.02, Number(e.target.value) || 0.02); this.roll.draw(); this.project.dirty = true; };
    $('#np-del').onclick = () => this.deleteSelectedNote();
    $('#np-len-minus').onclick = () => this.stretchSelected(-this.gridStep());
    $('#np-len-plus').onclick = () => this.stretchSelected(this.gridStep());
    $('#np-syl').onclick = () => {
      const ln = this.project.lines[this.selectedLine];
      if (!ln) { toast('歌詞行を選択してください', 'err'); return; }
      if (!ln.syllables || !ln.syllables.length) ln.syllables = splitSyllables(ln);
      // 選択ノートより前の音節を結合して開始位置を合わせる
      let target = ln.syllables.find((s) => s.start >= n.start - 0.001);
      if (!target) target = ln.syllables[ln.syllables.length - 1];
      if (target) {
        target.start = round2(n.start);
        this.renderLyrics();
        this._selectLine(this.selectedLine);
        this.project.dirty = true;
        toast(`音節「${target.text}」の開始を ${n.start.toFixed(2)}s に設定`);
      }
    };
  }

  deleteSelectedNote() {
    const i = this.project.notes.indexOf(this.selectedNote);
    if (i >= 0) {
      this.project.notes.splice(i, 1);
      this.selectedNote = null;
      this.roll.draw();
      this.updateNoteProps();
      this.project.dirty = true;
    }
  }

  /** 現在のグリッド幅（秒）。切なしなら 0.05 秒 */
  gridStep() {
    const snapVal = Number($('#ed-snap').value) || 0;
    const beat = 60 / (Number($('#ed-bpm').value) || 120);
    return snapVal > 0 ? Math.round(beat * snapVal * 1000) / 1000 : 0.05;
  }

  /** 選択ノートの長さを伸ばす / 短くする（+ は伸ばし、− は短縮） */
  stretchSelected(delta) {
    const n = this.selectedNote;
    if (!n) { toast('先にノートを選択してください', 'err'); return; }
    const next = Math.max(0.02, Math.round((n.dur + delta) * 1000) / 1000);
    if (next === n.dur) return;
    n.dur = next;
    this.project.dirty = true;
    this.roll.draw();
    this.updateNoteProps();
  }

  markDirty() { this.project.dirty = true; }

  // ------------------------------------------------------------------
  //  UI バインド
  // ------------------------------------------------------------------
  _bindUI() {
    $('#ed-audio-load').onclick = async () => {
      const f = await pickFile('audio/*,.mp3,.wav,.ogg,.m4a');
      if (f) this.importAudio(f);
    };
    $('#ed-video-load').onclick = async () => {
      const f = await pickFile('video/*,.mp4,.webm,.mov');
      if (f) this.importVideo(f);
    };
    $('#ed-midi-load').onclick = async () => {
      const f = await pickFile('.mid,.midi,audio/midi');
      if (f) await this.importMidi(f);
    };
    $('#ed-ksg-open').onclick = async () => {
      const f = await pickFile('.ksg,application/zip');
      if (f) {
        try { await this.openKsg(f); }
        catch (e) { console.error(e); toast(`読み込み失敗: ${e.message}`, 'err'); }
      }
    };
    $('#ed-save-lib').onclick = () => this.saveToLibrary().catch((e) => toast(e.message, 'err'));
    $('#ed-export').onclick = () => this.exportKsg().catch((e) => toast(e.message, 'err'));

    $('#ed-play').onclick = () => this.play();
    $('#ed-testplay') && ($('#ed-testplay').onclick = () => this.play());
    $('#ed-stop').onclick = () => this.stop();

    $('#ed-title').onchange = () => { this._readFields(); };
    $('#ed-artist').onchange = () => { this._readFields(); };
    $('#ed-bpm').onchange = () => { this._readFields(); };
    $('#ed-offset').onchange = () => { this._readFields(); };

    $('#ed-snap').onchange = (e) => { this.view.snap = Number(e.target.value); };
    $('#ed-zoom').oninput = (e) => {
      const center = this.view.scrollT + ($('#ed-pianoroll').clientWidth - this.view.gutter) / 2 / this.view.pps;
      this.view.pps = Number(e.target.value);
      this.view.scrollT = Math.max(0, center - ($('#ed-pianoroll').clientWidth - this.view.gutter) / 2 / this.view.pps);
      this.roll.draw();
      this.waveform.draw(this.view);
      this._updateHead(this.engine.time || 0);
    };

    $('#lp-add-line').onclick = () => this.addLine();
    $('#lp-autosplit').onclick = () => this.autoSplit();
    $('#lp-align').onclick = () => this.alignToNotes();

    // 波形クリックでシーク
    const wrap = document.querySelector('.wave-wrap');
    if (wrap) {
      let scrubbing = false;
      const doSeek = (e) => {
        const r = $('#ed-waveform').getBoundingClientRect();
        const x = e.clientX - r.left;
        const t = this.view.scrollT + (x - this.view.gutter) / this.view.pps;
        this.seek(t);
      };
      wrap.addEventListener('pointerdown', (e) => { scrubbing = true; doSeek(e); });
      window.addEventListener('pointermove', (e) => { if (scrubbing) doSeek(e); });
      window.addEventListener('pointerup', () => { scrubbing = false; });
    }

    // 波形 / ピアノロール上のホイールで時間スクロール
    document.addEventListener('wheel', (e) => {
      if (!$('#view-editor') || $('#view-editor').classList.contains('hidden')) return;
      const onRoll = e.target.closest && e.target.closest('#ed-pianoroll');
      if (onRoll) return; // roll 側で処理済み
      const onWave = e.target.closest && e.target.closest('.wave-wrap');
      if (!onWave) return;
      e.preventDefault();
      this.view.scrollT = Math.max(0, this.view.scrollT + (e.deltaY + (e.deltaX || 0)) / this.view.pps);
      this.roll.draw();
      this.waveform.draw(this.view);
      this._updateHead(this.engine.time || 0);
    }, { passive: false });

    // 削除キー
    document.addEventListener('keydown', (e) => {
      const view = $('#view-editor');
      if (!view || view.classList.contains('hidden')) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedNote) { e.preventDefault(); this.deleteSelectedNote(); }
      }
      // ノートの伸長 / 短縮（現在のグリッド幅だけ）
      if (e.key === ']' || e.key === '}') { e.preventDefault(); this.stretchSelected(this.gridStep()); }
      if (e.key === '[' || e.key === '{') { e.preventDefault(); this.stretchSelected(-this.gridStep()); }
      // Space による再生は app.js のグローバルハンドラが一括で扱う
    });
  }

  /** エディタを開いたときの再描画 */
  activate() {
    this.roll.draw();
    this.waveform.draw(this.view);
    this._updateHead(this.engine.time || 0);
    this.renderLyrics();
  }
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

/**
 * MIDI の Lyric イベント列から歌詞行を作る
 * @param {Array<{time:number,text:string}>} events  時刻昇順
 * @returns {Array<{id,text,start,end,syllables}>}
 */
function linesFromLyricEvents(events) {
  const groups = [];
  let cur = null;
  for (const ev of events) {
    const text = String(ev.text ?? '').replace(/[\r\n]+/g, '');
    const t = Number(ev.time) || 0;
    if (!cur || t - cur.end > 0.7) {          // 0.7 秒以上の間隔で改行
      cur = { start: t, end: t + 0.3, syl: [] };
      groups.push(cur);
    }
    cur.syl.push({ text, start: t });
    cur.end = t + 0.3;
  }

  return groups.map((g) => {
    const syllables = g.syl.map((s, i) => ({
      text: s.text,
      start: round2(s.start),
      end: round2(i + 1 < g.syl.length ? g.syl[i + 1].start : g.end),
    }));
    return {
      id: uid(),
      text: g.syl.map((s) => s.text).join(''),
      start: round2(g.start),
      end: round2(g.end),
      syllables,
    };
  });
}

function noteName(m) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const pc = ((m % 12) + 12) % 12;
  return `${names[pc]}${Math.floor(m / 12) - 1} (MIDI ${m})`;
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normalizeAudioName(name) {
  const ext = (name.split('.').pop() || 'mp3').toLowerCase();
  const ok = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'];
  return `audio.${ok.includes(ext) ? ext : 'mp3'}`;
}

function normalizeVideoName(name) {
  const ext = (name.split('.').pop() || 'mp4').toLowerCase();
  const ok = ['mp4', 'webm', 'mov', 'm4v'];
  return `bg.${ok.includes(ext) ? ext : 'mp4'}`;
}
