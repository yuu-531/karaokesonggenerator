// ksg.js — .ksg ファイル (実体は ZIP) の読み込み / 書き出し
//
// .ksg 内部構造
//   info.json    … メタデータ { title, artist, bpm, key, offset, duration, ... }
//   audio.mp3    … 伴奏・ボーカル音源 (mp3 / wav / ogg / m4a なども許容)
//   bg.mp4       … 背景映像 (任意, webm/mov も許容)
//   melody.mid   … 音程バー・採点用 SMF
//   notes.json   … ノートの正確な値 (任意。同一ピッチ重なりの曖昧さ回避に使用)
//   lyrics.json  … タイムスタンプ付き歌詞
//   cover.png    … ジャケット (任意)
//
import { parseMidi } from './midi.js';
import { clamp } from './util.js';

const JSZipLib = () => {
  const z = (typeof window !== 'undefined') ? window.JSZip : null;
  if (!z) throw new Error('JSZip が読み込まれていません');
  return z;
};

const AUDIO_NAMES = ['audio.mp3', 'audio.wav', 'audio.ogg', 'audio.m4a', 'audio.aac', 'audio.flac', 'audio.webm'];
const VIDEO_NAMES = ['bg.mp4', 'bg.webm', 'bg.mov', 'bg.m4v', 'bg.avi'];

function pickEntry(zip, names) {
  for (const n of names) {
    const f = zip.file(n) || zip.file(new RegExp('^' + n.replace('.', '\\.') + '$', 'i'))[0];
    if (f) return f;
  }
  // "audio.*" のようなワイルド対応
  const files = Object.keys(zip.files);
  for (const n of names) {
    const base = n.split('.')[0];
    const hit = files.find((f) => f.startsWith(base + '.') && !zip.files[f].dir);
    if (hit) return zip.file(hit);
  }
  return null;
}

function normalizeLyrics(raw) {
  const out = { version: 1, lines: [] };
  if (!raw) return out;
  const lines = Array.isArray(raw) ? raw : (raw.lines || []);
  for (const ln of lines) {
    if (typeof ln === 'string') {
      out.lines.push({ text: ln, start: 0, end: 0, syllables: [] });
      continue;
    }
    const syllables = (ln.syllables || ln.chars || []).map((s) => ({
      text: String(s.text ?? s.t ?? ''),
      start: Number(s.start ?? s.time ?? s.t ?? 0),
      end: Number(s.end ?? s.e ?? s.d ?? 0) || Number(s.start ?? s.time ?? 0),
    }));
    const line = {
      text: String(ln.text ?? ln.lyric ?? ''),
      start: Number(ln.start ?? 0),
      end: Number(ln.end ?? 0),
      syllables,
    };
    if (!line.end && syllables.length) line.end = Math.max(...syllables.map((s) => s.end || s.start));
    out.lines.push(line);
  }
  return out;
}

function normalizeInfo(raw, fallback = {}) {
  const info = Object.assign({
    version: 1,
    title: '無題',
    artist: '',
    bpm: 120,
    key: 0,
    offset: 0,
    duration: 0,
  }, raw || {}, fallback);
  info.title = String(info.title || '無題');
  info.artist = String(info.artist || '');
  info.bpm = Number(info.bpm) || 120;
  info.key = Number(info.key) || 0;
  info.offset = Number(info.offset) || 0;
  info.duration = Number(info.duration) || 0;
  return info;
}

/**
 * .ksg を読み込んで展開する
 * @param {File|Blob} file
 * @returns {Promise<Object>} { info, lyrics, notes, midiBuffer, audioBlob, audioName, videoBlob, videoName, coverBlob, entries }
 */
export async function readKsg(file) {
  const JSZip = JSZipLib();
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (e) {
    throw new Error('ZIP を展開できませんでした。.ksg ファイルとして有効ではありません。');
  }

  const entries = Object.keys(zip.files).filter((n) => !zip.files[n].dir);

  // --- info.json ---
  let infoRaw = null;
  const infoEntry = zip.file('info.json');
  if (infoEntry) {
    try { infoRaw = JSON.parse(await infoEntry.async('string')); }
    catch (e) { throw new Error('info.json の JSON が不正です'); }
  }

  // --- audio ---
  const audioEntry = pickEntry(zip, AUDIO_NAMES);
  if (!audioEntry) throw new Error('音源ファイル (audio.mp3 など) が見つかりません');
  const audioBlob = await audioEntry.async('blob');

  // --- video ---
  const videoEntry = pickEntry(zip, VIDEO_NAMES);
  const videoBlob = videoEntry ? await videoEntry.async('blob') : null;

  // --- lyrics ---
  let lyrics = normalizeLyrics(null);
  const lyricsEntry = zip.file('lyrics.json');
  if (lyricsEntry) {
    try { lyrics = normalizeLyrics(JSON.parse(await lyricsEntry.async('string'))); }
    catch (e) { console.warn('[ksg] lyrics.json の解析に失敗', e); }
  }

  // --- MIDI ---
  let midiBuffer = null;
  let notes = [];
  const midiEntry = zip.file('melody.mid');
  if (midiEntry) {
    try {
      midiBuffer = await midiEntry.async('arraybuffer');
      notes = parseMidi(midiBuffer).notes;
    } catch (e) {
      console.warn('[ksg] melody.mid の解析に失敗', e);
      notes = [];
    }
  }

  // --- ノート (任意・正確な長さの保持用) ---
  // 同一ピッチが重なると SMF のノートオン/オフ対応が曖昧になるため、
  // 自アプリは notes.json を優先して読む（無ければ melody.mid を使用）
  const notesEntry = zip.file('notes.json');
  if (notesEntry) {
    try {
      const raw = JSON.parse(await notesEntry.async('string'));
      const list = Array.isArray(raw) ? raw : (raw.notes || []);
      const norm = list
        .map((n) => ({
          midi: clamp(Math.round(Number(n.midi) || 0), 0, 127),
          start: Math.max(0, Number(n.start) || 0),
          dur: Math.max(0.02, Number(n.dur) || 0.02),
        }))
        .sort((a, b) => a.start - b.start);
      if (norm.length) notes = norm;
    } catch (e) {
      console.warn('[ksg] notes.json の解析に失敗', e);
    }
  }

  // --- cover ---
  const coverEntry = zip.file('cover.png') || zip.file('cover.jpg');
  const coverBlob = coverEntry ? await coverEntry.async('blob') : null;

  const info = normalizeInfo(infoRaw);

  return {
    info,
    lyrics,
    notes,
    midiBuffer,
    audioBlob,
    audioName: audioEntry.name,
    videoBlob,
    videoName: videoEntry ? videoEntry.name : null,
    coverBlob,
    entries,
    fileName: file.name || '',
  };
}

/**
 * .ksg (ZIP) を組み立てて Blob を返す
 * @param {Object} data
 *   info       : Object  (info.json)
 *   lyrics     : Object  (lyrics.json)
 *   midi       : ArrayBuffer | Uint8Array (melody.mid) — 省略可
 *   audioBlob  : Blob    (必須)
 *   audioName  : string  'audio.mp3' 既定
 *   videoBlob  : Blob | null
 *   coverBlob  : Blob | null
 */
export async function buildKsg(data) {
  const JSZip = JSZipLib();
  const zip = new JSZip();

  const info = normalizeInfo(data.info);
  zip.file('info.json', JSON.stringify(info, null, 2));
  zip.file('lyrics.json', JSON.stringify(data.lyrics || { version: 1, lines: [] }, null, 2));

  if (data.midi) {
    zip.file('melody.mid', data.midi instanceof ArrayBuffer ? data.midi : data.midi.buffer);
  }
  // ノートの正確な長さを保持（同一ピッチの重なりがあると SMF だけでは曖昧になるため）
  if (data.notes && data.notes.length) {
    zip.file('notes.json', JSON.stringify({
      version: 1,
      notes: data.notes.map((n) => ({ midi: n.midi, start: n.start, dur: n.dur })),
    }, null, 2));
  }
  if (!data.audioBlob) throw new Error('音源 Blob が必要です');
  zip.file(data.audioName || 'audio.mp3', data.audioBlob);
  if (data.videoBlob) zip.file(data.videoName || 'bg.mp4', data.videoBlob);
  if (data.coverBlob) zip.file('cover.png', data.coverBlob);

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => { if (data.onProgress) data.onProgress(meta.percent); }
  );
  return blob;
}

/** info からファイル名をつくる */
export function ksgFileName(info) {
  const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'song';
  return `${safe(info.title)} - ${safe(info.artist) || 'unknown'}.ksg`;
}

/** 再生互換のための MIME 猜定 */
export function guessMime(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ({
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
    png: 'image/png', jpg: 'image/jpeg',
  })[ext] || 'application/octet-stream';
}
