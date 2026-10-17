// store.js — IndexedDB(曲データ) + localStorage(設定 / ハイスコア)
import { loadJSON, storeJSON, uid } from './util.js';

const DB_NAME = 'ksg-db';
const DB_VER = 1;
const LS_SONGS = 'ksg_highscores';
const LS_SETTINGS = 'ksg_settings';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('songs')) {
        const st = db.createObjectStore('songs', { keyPath: 'id' });
        st.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('songs', mode);
    const st = t.objectStore('songs');
    const out = fn(st);
    t.oncomplete = () => resolve(out && out.__val !== undefined ? out.__val : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

/** 曲を保存（新規 or 上書き） */
export async function putSong({ info, lyrics, midi, notes, audioBlob, audioName, videoBlob, videoName, id }) {
  const db = await openDB();
  const rec = {
    id: id || uid(),
    createdAt: Date.now(),
    info,
    lyrics,
    midi: midi || null,          // ArrayBuffer はそのまま保存可
    notes: notes || null,        // 正確なノート（同一ピッチ重なりの曖昧さ回避）
    audioBlob,
    audioName: audioName || 'audio.mp3',
    videoBlob: videoBlob || null,
    videoName: videoName || null,
  };
  await tx(db, 'readwrite', (st) => { st.put(rec); });
  return rec.id;
}

/** 全曲のメタ一覧（Blob を含まない軽い情報のみ） */
export async function listSongs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('songs', 'readonly');
    const st = t.objectStore('songs');
    const req = st.getAll();
    req.onsuccess = () => {
      const rows = (req.result || []).map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        info: r.info,
        hasVideo: !!r.videoBlob,
        hasMidi: !!r.midi,
        lineCount: (r.lyrics && r.lyrics.lines || []).length,
        noteCount: r.notes && r.notes.length ? r.notes.length : (r.midi ? -1 : 0),
      })).sort((a, b) => b.createdAt - a.createdAt);
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 曲のレコード本体を取得 */
export async function getSong(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction('songs', 'readonly');
    const req = t.objectStore('songs').get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSong(id) {
  const db = await openDB();
  await tx(db, 'readwrite', (st) => { st.delete(id); });
}

export async function countSongs() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('songs', 'readonly').objectStore('songs').count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAllSongs() {
  const db = await openDB();
  await tx(db, 'readwrite', (st) => { st.clear(); });
}

// ------------------------- ハイスコア -------------------------
export function loadHighscores() { return loadJSON(LS_SONGS, {}); }

export function addHighscore(songId, result) {
  const all = loadHighscores();
  const list = all[songId] || [];
  list.push({
    score: result.score,
    accuracy: result.accuracy,
    perfect: result.perfect,
    good: result.good,
    miss: result.miss,
    maxCombo: result.maxCombo,
    at: Date.now(),
  });
  list.sort((a, b) => b.score - a.score);
  all[songId] = list.slice(0, 10);
  storeJSON(LS_SONGS, all);
  return all[songId][0];
}

export function bestScore(songId) {
  const list = loadHighscores()[songId];
  return list && list.length ? list[0] : null;
}

export function clearHighscores() { storeJSON(LS_SONGS, {}); }

export function countHighscores() {
  const all = loadHighscores();
  return Object.values(all).reduce((n, l) => n + l.length, 0);
}

// ------------------------- 設定 -------------------------
const DEFAULT_SETTINGS = {
  difficulty: 'normal',   // easy | normal | hard
  lyricsGlow: true,
  monitor: false,         // マイク監視出力
  autoMic: true,          // 曲開始時に自動でマイク接続
  defaultEcho: 25,
  notePreview: true,      // エディタでノート / 鍵盤を操作したときの試聴音
  musicVolume: 100,       // 楽曲の再生音量 0〜100（録音の音量には影響しない）
  toneVolume: 70,         // 試聴音（ピープ音・メロディ試聴）の音量 0〜100
};

export function loadSettings() {
  return Object.assign({}, DEFAULT_SETTINGS, loadJSON(LS_SETTINGS, {}));
}
export function saveSettings(patch) {
  const s = Object.assign(loadSettings(), patch);
  storeJSON(LS_SETTINGS, s);
  return s;
}
export { DEFAULT_SETTINGS };
