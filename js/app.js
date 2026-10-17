// app.js — アプリケーションの起動 / 画面遷移 / ライブラリ / 設定
import { $, $$, toast, formatTime, pickFile, download, storeJSON, loadJSON } from './util.js';
import { readKsg, buildKsg, ksgFileName } from './ksg.js';
import {
  listSongs, getSong, putSong, deleteSong, countSongs, clearAllSongs,
  clearHighscores, countHighscores, loadSettings, saveSettings,
} from './store.js';
import { AudioEngine } from './audio-engine.js';
import { Player } from './player.js';
import { Editor } from './editor.js';
import { generateDemo } from './demo.js';

// ---------------------------------------------------------------------
//  依存オブジェクト
// ---------------------------------------------------------------------
const engine = new AudioEngine();
const player = new Player(engine);
const editor = new Editor();
let settings = loadSettings();

editor.onSaved = () => refreshLibrary();

// デバッグ / E2E 用ハンドル
window.ksg = { engine, player, editor, readKsg, buildKsg };

// ---------------------------------------------------------------------
//  ルーティング
// ---------------------------------------------------------------------
const VIEWS = ['library', 'play', 'editor', 'settings'];
let route = 'library';

function go(name) {
  if (!VIEWS.includes(name)) name = 'library';
  route = name;
  VIEWS.forEach((v) => {
    const el = $(`#view-${v}`);
    if (el) el.classList.toggle('hidden', v !== name);
  });
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.route === name));
  if (name === 'editor') editor.activate();
  if (name === 'library') refreshLibrary();
  if (name === 'settings') refreshSettings();
  window.scrollTo({ top: 0 });
}

$$('.nav-btn').forEach((b) => { b.onclick = () => go(b.dataset.route); });

// ---------------------------------------------------------------------
//  ライブラリ
// ---------------------------------------------------------------------
async function refreshLibrary() {
  let songs = [];
  try { songs = await listSongs(); } catch (e) { console.error(e); }

  const grid = $('#song-grid');
  const empty = $('#empty-state');
  grid.innerHTML = '';
  empty.classList.toggle('hidden', songs.length > 0);

  const scores = loadJSON('ksg_highscores', {});

  songs.forEach((s, i) => {
    const info = s.info || {};
    const best = (scores[s.id] && scores[s.id][0]) || null;
    const card = document.createElement('div');
    card.className = 'song-card';
    const hue = (Math.abs(hashCode(info.title || 'x')) % 360);
    card.innerHTML = `
      <div class="sc-cover" style="--hue:${hue}">
        <span class="sc-note">♪</span>
        ${s.hasVideo ? '<span class="sc-badge">VIDEO</span>' : ''}
      </div>
      <div class="sc-body">
        <div class="sc-title" title="${esc(info.title)}">${esc(info.title || '無題')}</div>
        <div class="sc-artist">${esc(info.artist || '')}</div>
        <div class="sc-meta">
          <span>${info.duration ? formatTime(info.duration) : '—:—'}</span>
          ${info.bpm ? `<span>${info.bpm} BPM</span>` : ''}
          ${s.hasMidi ? '<span class="ok">♪ MIDI</span>' : ''}
          ${s.lineCount ? `<span>歌詞 ${s.lineCount}行</span>` : ''}
          ${best ? `<span class="best">BEST ${best.score.toLocaleString()}</span>` : ''}
        </div>
      </div>
      <div class="sc-actions">
        <button class="btn primary small" data-act="play">▶ 再生</button>
        <button class="btn small" data-act="edit">✎ 編集</button>
        <button class="btn small" data-act="export" title=".ksg を書き出し">⬇</button>
        <button class="btn small danger" data-act="delete" title="削除">🗑</button>
      </div>`;

    card.querySelector('[data-act="play"]').onclick = () => openInPlayer(s.id, true);
    card.querySelector('[data-act="edit"]').onclick = () => openInEditor(s.id);
    card.querySelector('[data-act="export"]').onclick = () => exportSong(s.id);
    card.querySelector('[data-act="delete"]').onclick = async () => {
      if (!confirm(`「${info.title}」を削除しますか？`)) return;
      await deleteSong(s.id);
      toast('削除しました');
      refreshLibrary();
    };
    // カード本体（ボタン以外）をクリックしても再生できる
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openInPlayer(s.id, true);
    });
    grid.appendChild(card);
  });

  const cnt = $('#set-song-count');
  if (cnt) cnt.textContent = String(songs.length);
}

async function openInPlayer(id, autoplay = false) {
  try {
    toast('読み込み中…');
    const rec = await getSong(id);
    if (!rec) { toast('曲が見つかりません', 'err'); return; }
    await player.loadSong(rec);
    go('play');
    if (autoplay) await player.start();
  } catch (e) {
    console.error(e);
    toast(`読み込み失敗: ${e.message}`, 'err');
  }
}

async function openInEditor(id) {
  try {
    const rec = await getSong(id);
    if (!rec) { toast('曲が見つかりません', 'err'); return; }
    await editor.loadRecord(rec);
    go('editor');
  } catch (e) {
    console.error(e);
    toast(`編集を開けません: ${e.message}`, 'err');
  }
}

async function exportSong(id) {
  try {
    const rec = await getSong(id);
    if (!rec) return;
    const blob = await buildKsg({
      info: rec.info,
      lyrics: rec.lyrics,
      midi: rec.midi,
      notes: rec.notes,
      audioBlob: rec.audioBlob,
      audioName: rec.audioName,
      videoBlob: rec.videoBlob,
      videoName: rec.videoName,
    });
    download(blob, ksgFileName(rec.info));
    toast('.ksg を書き出しました');
  } catch (e) {
    console.error(e);
    toast(`書き出し失敗: ${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------------
//  .ksg インポート
// ---------------------------------------------------------------------
async function importKsgFiles(files, target = 'library') {
  const list = Array.from(files).filter((f) => /\.(ksg|zip)$/i.test(f.name));
  if (!list.length) { toast('.ksg ファイルではありません', 'err'); return; }

  for (const file of list) {
    try {
      const data = await readKsg(file);
      if (target === 'editor') {
        await editor.openKsg(file);
        go('editor');
        continue;
      }
      const id = await putSong({
        info: data.info,
        lyrics: data.lyrics,
        midi: data.midiBuffer,
        notes: data.notes,
        audioBlob: data.audioBlob,
        audioName: data.audioName,
        videoBlob: data.videoBlob,
        videoName: data.videoName,
      });
      toast(`「${data.info.title}」を読み込みました`);
      await refreshLibrary();
      // 読み込んだ直後は再生画面へ
      if (list.length === 1) await openInPlayer(id, false);
    } catch (e) {
      console.error(e);
      toast(`${file.name}: ${e.message}`, 'err');
    }
  }
}

$('#btn-import-ksg').onclick = async () => {
  const files = await pickFile('.ksg,application/zip', true);
  if (files && files.length) importKsgFiles(files);
};

$('#btn-new-project').onclick = () => {
  editor.resetProject('新規プロジェクトを開始しました');
  go('editor');
};

$('#btn-load-demo').onclick = async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const demo = await generateDemo((m) => { btn.textContent = `生成中… ${m}`; });
    const id = await putSong({
      info: demo.info,
      lyrics: demo.lyrics,
      midi: demo.midi,
      audioBlob: demo.audioBlob,
      audioName: demo.audioName,
    });
    toast('デモ曲を生成しました');
    await refreshLibrary();
    await openInPlayer(id, false);
  } catch (err) {
    console.error(err);
    toast(`デモ生成失敗: ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'デモ曲を生成';
  }
};

// ファイル選択
$('#file-ksg').onchange = (e) => { if (e.target.files.length) importKsgFiles(e.target.files); e.target.value = ''; };

// ドラッグ＆ドロップ
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('#drop-overlay').classList.remove('hidden');
});
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) $('#drop-overlay').classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').classList.add('hidden');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (!files || !files.length) return;

  const all = Array.from(files);
  const midis = all.filter((f) => /\.(mid|midi)$/i.test(f.name));
  const others = all.filter((f) => !/\.(mid|midi)$/i.test(f.name));

  if (midis.length) {
    if (route === 'editor') midis.forEach((f) => editor.importMidi(f));
    else toast('MIDI はエディタ画面で開けます', 'err');
  }
  if (others.length) importKsgFiles(others, route === 'editor' ? 'editor' : 'library');
});

// ---------------------------------------------------------------------
//  設定
// ---------------------------------------------------------------------
function applySettingsToUI() {
  $('#set-difficulty').value = settings.difficulty;
  $('#set-lyrics-glow').checked = settings.lyricsGlow;
  $('#set-monitor').checked = settings.monitor;
  $('#set-auto-mic').checked = settings.autoMic;
  player.settings = settings;
  player.lyrics.setGlow(settings.lyricsGlow);
  if (player.scorer) player.scorer.setDifficulty(settings.difficulty);
}

function refreshSettings() {
  applySettingsToUI();
  countSongs().then((n) => { $('#set-song-count').textContent = String(n); }).catch(() => {});
  $('#set-score-count').textContent = String(countHighscores());
}

$('#set-difficulty').onchange = (e) => {
  settings = saveSettings({ difficulty: e.target.value });
  if (player.scorer) player.scorer.setDifficulty(e.target.value);
  toast('判定の厳しさを変更しました');
};
$('#set-lyrics-glow').onchange = (e) => {
  settings = saveSettings({ lyricsGlow: e.target.checked });
  player.lyrics.setGlow(e.target.checked);
};
$('#set-monitor').onchange = (e) => {
  settings = saveSettings({ monitor: e.target.checked });
  engine.setMonitor(e.target.checked);
  const b = $('#btn-monitor');
  b.textContent = e.target.checked ? '監視ON' : '監視OFF';
  b.classList.toggle('on', e.target.checked);
};
$('#set-auto-mic').onchange = (e) => { settings = saveSettings({ autoMic: e.target.checked }); };
$('#set-clear-scores').onclick = () => {
  if (!confirm('ハイスコアを全て消去しますか？')) return;
  clearHighscores();
  refreshSettings();
  refreshLibrary();
  toast('スコアを消去しました');
};
$('#set-clear-all').onclick = async () => {
  if (!confirm('保存されている曲・スコア・設定を全て消去しますか？この操作は取り消せません。')) return;
  await clearAllSongs();
  clearHighscores();
  storeJSON('ksg_settings', {});
  settings = loadSettings();
  applySettingsToUI();
  refreshSettings();
  refreshLibrary();
  toast('全データを消去しました');
};

// ---------------------------------------------------------------------
//  キーボード
// ---------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (e.key === 'Escape') {
    $('#result-modal').classList.add('hidden');
    return;
  }
  if (typing) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (route === 'play') player.toggle();
    else if (route === 'editor') editor.play();
    return;
  }
  if (route !== 'play') return;

  switch (e.key) {
    case 'ArrowLeft': e.preventDefault(); player.seek(engine.time - 5); break;
    case 'ArrowRight': e.preventDefault(); player.seek(engine.time + 5); break;
    case 'ArrowUp': e.preventDefault(); engine.setTranspose(engine.transpose + 1); syncKeyUI(); break;
    case 'ArrowDown': e.preventDefault(); engine.setTranspose(engine.transpose - 1); syncKeyUI(); break;
    case 'r': case 'R': player.toggleRec(); break;
    default: break;
  }
});

function syncKeyUI() {
  $('#key-val').textContent = (engine.transpose > 0 ? '+' : '') + engine.transpose;
  if (player.scorer) player.scorer.setOffset(engine.pitchOffsetSemis);
}

// ---------------------------------------------------------------------
//  モーダル
// ---------------------------------------------------------------------
$$('.modal-close').forEach((b) => { b.onclick = () => $(`#${b.dataset.close}`).classList.add('hidden'); });
$('#result-modal').addEventListener('click', (e) => {
  if (e.target.id === 'result-modal') $('#result-modal').classList.add('hidden');
});

// ---------------------------------------------------------------------
//  起動
// ---------------------------------------------------------------------
function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function boot() {
  applySettingsToUI();
  await refreshLibrary();
  go('library');

  // URL パラメータで画面指定 (?view=play など)
  const params = new URLSearchParams(location.search);
  const v = params.get('view');
  if (v && VIEWS.includes(v)) go(v);

  // 初回のみデモ曲の用意を促す
  const n = await countSongs().catch(() => 0);
  if (n === 0) toast('まずは「デモ曲を生成」か「.ksg を読み込む」で始めましょう');
}

boot();
