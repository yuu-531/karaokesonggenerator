// midi.js — スタンダードMIDIファイル(SMF)のパーサ / ライタ
//
// parseMidi(buf) : バイト列 → { ppq, format, tracks, bpm, notes[], lyrics[] }
//   notes[] : { start, end, dur, midi, velocity, track, channel }  (秒単位)
// writeMidi(...) : notes + 歌詞 → SMF format1 の ArrayBuffer (エクスポート用)
//

// ---- 可変長エンコード(VarLen)読み取り ----
function readVarLen(dv, pos) {
  let value = 0, b;
  do {
    b = dv.getUint8(pos.i++);
    value = (value << 7) | (b & 0x7f);
  } while (b & 0x80);
  return value;
}

// ---- メインパーサ ----
export function parseMidi(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  if (dv.byteLength < 14) throw new Error('MIDIファイルが短すぎます');

  const tag = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (tag !== 'MThd') throw new Error('MThd チャンクが見つかりません（MIDIではありません）');

  const headerLen = dv.getUint32(4);
  const format = dv.getUint16(8);
  const ntrks = dv.getUint16(10);
  const division = dv.getUint16(12);

  // ディビジョン: MSB=1 の場合は SMPTE 時間
  let ppq = 480, smpte = null;
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);      // 負の値 (24/25/29/30)
    const tpf = division & 0xff;
    smpte = { fps, tpf, secPerTick: 1 / (fps * tpf) };
  } else {
    ppq = division;
  }

  let pos = { i: 8 + headerLen };
  const rawTracks = [];
  for (let t = 0; t < ntrks && pos.i + 8 <= dv.byteLength; t++) {
    const cid = String.fromCharCode(dv.getUint8(pos.i), dv.getUint8(pos.i + 1), dv.getUint8(pos.i + 2), dv.getUint8(pos.i + 3));
    const len = dv.getUint32(pos.i + 4);
    pos.i += 8;
    if (cid !== 'MTrk') { pos.i += len; continue; }
    rawTracks.push({ start: pos.i, end: Math.min(pos.i + len, dv.byteLength), index: rawTracks.length });
    pos.i += len;
  }

  // ---- 各トラックをイベントへ展開 ----
  const events = [];      // { tick, type, ... }
  const tempoChanges = []; // { tick, usPerQuarter }

  for (const tr of rawTracks) {
    let p = { i: tr.start };
    let tick = 0;
    let running = null;
    const end = tr.end;

    while (p.i < end) {
      tick += readVarLen(dv, p);
      let status = dv.getUint8(p.i);

      if (status < 0x80) {
        if (running === null) throw new Error('ランニングステータスが不正です');
        status = running;
      } else {
        p.i++;
        if (status < 0xf0) running = status;
        else if (status < 0xf8) running = null; // SysEx等で解除
      }

      if (status === 0xff) {                    // Meta イベント
        const type = dv.getUint8(p.i++);
        const len = readVarLen(dv, p);
        const dataStart = p.i;
        if (type === 0x51 && len === 3) {
          const us = (dv.getUint8(dataStart) << 16) | (dv.getUint8(dataStart + 1) << 8) | dv.getUint8(dataStart + 2);
          tempoChanges.push({ tick, usPerQuarter: us });
        } else if (type === 0x05 || type === 0x01) { // 歌詞 / テキスト
          let s = '';
          for (let k = 0; k < len; k++) {
            const c = dv.getUint8(dataStart + k);
            s += String.fromCharCode(c);
          }
          events.push({ tick, type: 'lyric', text: decodeURIComponent(escape(s)) || s, track: tr.index });
        } else if (type === 0x2f) {
          p.i = end; // End of Track
          break;
        }
        p.i = dataStart + len;
      } else if (status === 0xf0 || status === 0xf7) { // SysEx
        const len = readVarLen(dv, p);
        p.i += len;
      } else {
        const hi = status & 0xf0;
        const ch = status & 0x0f;
        if (hi === 0xc0 || hi === 0xd0) {       // Program Change / Channel Pressure
          const d1 = dv.getUint8(p.i++);
          if (hi === 0xc0) events.push({ tick, type: 'program', channel: ch, program: d1, track: tr.index });
        } else {
          const d1 = dv.getUint8(p.i++);
          const d2 = dv.getUint8(p.i++);
          if (hi === 0x90 && d2 > 0) events.push({ tick, type: 'on', channel: ch, midi: d1, velocity: d2, track: tr.index });
          else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) events.push({ tick, type: 'off', channel: ch, midi: d1, velocity: d2, track: tr.index });
          else if (hi === 0xa0) events.push({ tick, type: 'aftertouch', channel: ch, midi: d1, value: d2, track: tr.index });
          else if (hi === 0xb0) events.push({ tick, type: 'cc', channel: ch, controller: d1, value: d2, track: tr.index });
          else if (hi === 0xe0) events.push({ tick, type: 'pitchbend', channel: ch, value: (d2 << 7) | d1, track: tr.index });
        }
      }
    }
  }

  // ---- テンポマップ → tick を秒へ変換 ----
  tempoChanges.sort((a, b) => a.tick - b.tick);
  if (tempoChanges.length === 0) tempoChanges.push({ tick: 0, usPerQuarter: 500000 });

  const tickToSec = makeTickConverter(tempoChanges, ppq, smpte);
  const bpm = Math.round(60000000 / tempoChanges[0].usPerQuarter * 100) / 100;

  // ---- ノートオン/オフをペアリング ----
  const noteOns = events.filter((e) => e.type === 'on').sort((a, b) => a.tick - b.tick);
  const pending = new Map(); // key: track:ch:midi → stack
  const notes = [];

  const all = events.slice().sort((a, b) => a.tick - b.tick);
  for (const ev of all) {
    if (ev.type === 'on') {
      const key = `${ev.track}:${ev.channel}:${ev.midi}`;
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(ev);
    } else if (ev.type === 'off') {
      const key = `${ev.track}:${ev.channel}:${ev.midi}`;
      const stack = pending.get(key);
      if (stack && stack.length) {
        const on = stack.shift();
        const start = tickToSec(on.tick);
        const end = tickToSec(ev.tick);
        notes.push({
          start, end,
          dur: Math.max(0.02, end - start),
          midi: on.midi,
          velocity: on.velocity,
          track: on.track,
          channel: on.channel,
        });
      }
    }
  }
  // 未クローズのノート (end 未定) を補完
  for (const [key, stack] of pending) {
    for (const on of stack) {
      const start = tickToSec(on.tick);
      notes.push({ start, end: start + 0.5, dur: 0.5, midi: on.midi, velocity: on.velocity, track: on.track, channel: on.channel });
    }
  }

  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);

  const lyrics = events.filter((e) => e.type === 'lyric')
    .map((e) => ({ time: tickToSec(e.tick), text: e.text }))
    .sort((a, b) => a.time - b.time);

  return { format, ppq, bpm, tracks: rawTracks.length, notes, lyrics, tempoChanges, tickToSec, secToTick: makeSecToTick(tempoChanges, ppq, smpte) };
}

function makeTickConverter(tempoChanges, ppq, smpte) {
  if (smpte) {
    return (tick) => tick * smpte.secPerTick;
  }
  // 各テンポ区間の累積秒を事前計算
  const marks = [];
  let sec = 0;
  let prevTick = 0;
  let us = tempoChanges[0].usPerQuarter;
  for (const tc of tempoChanges) {
    sec += (tc.tick - prevTick) * us / 1000000 / ppq;
    prevTick = tc.tick;
    us = tc.usPerQuarter;
    marks.push({ tick: tc.tick, sec, us });
  }
  marks[0].sec = tempoChanges[0].tick === 0 ? 0 : marks[0].sec;
  return (tick) => {
    if (tick <= 0) return 0;
    let m = marks[0];
    for (let i = marks.length - 1; i >= 0; i--) {
      if (marks[i].tick <= tick) { m = marks[i]; break; }
    }
    return m.sec + (tick - m.tick) * m.us / 1000000 / ppq;
  };
}

function makeSecToTick(tempoChanges, ppq, smpte) {
  if (smpte) return (sec) => sec / smpte.secPerTick;
  const tc0 = tempoChanges[0];
  if (tempoChanges.length === 1) {
    return (sec) => sec * 1000000 / tc0.usPerQuarter * ppq;
  }
  return (sec) => {
    // 近似: 単一テンポ扱い(初回テンポ) + 差分補正は行わない
    return sec * 1000000 / tc0.usPerQuarter * ppq;
  };
}

// ======================================================================
//  ライタ: notes[] → SMF format 1 (トラック0=テンポ, 1=メロディ, 2=歌詞)
// ======================================================================
function varLen(value) {
  value = Math.max(0, Math.floor(value));
  const bytes = [value & 0x7f];
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function buildTrack(events) {
  // events: [{ tick, bytes:[] }] を tick 昇順で delta エンコード
  events.sort((a, b) => a.tick - b.tick);
  const out = [];
  let last = 0;
  for (const ev of events) {
    out.push(...varLen(ev.tick - last), ...ev.bytes);
    last = ev.tick;
  }
  out.push(...varLen(0), 0xff, 0x2f, 0x00); // End of Track
  return new Uint8Array(out);
}

function chunk(id, data) {
  const head = new Uint8Array(8);
  for (let i = 0; i < 4; i++) head[i] = id.charCodeAt(i);
  head.set([(data.length >> 24) & 0xff, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff], 4);
  const out = new Uint8Array(8 + data.length);
  out.set(head, 0);
  out.set(data, 8);
  return out;
}

/**
 * notes(秒) + lyrics → MIDI ArrayBuffer
 * @param {Array} notes  [{ start, dur, midi, velocity? }]
 * @param {Object} opt   { bpm, lyrics:[{time,text}], ppq, program }
 */
export function writeMidi(notes, opt = {}) {
  const ppq = opt.ppq || 480;
  const bpm = opt.bpm || 120;
  const usPerQuarter = Math.round(60000000 / bpm);
  const secToTick = (sec) => Math.round(sec * 1000000 / usPerQuarter * ppq);
  const program = opt.program == null ? 0 : opt.program;

  // トラック0: テンポ
  const t0 = buildTrack([
    { tick: 0, bytes: [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff] },
    { tick: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] }, // 4/4
  ]);

  // トラック1: メロディ
  const ev1 = [{ tick: 0, bytes: [0xc0, program] }];
  for (const n of notes) {
    const on = secToTick(n.start);
    const off = Math.max(on + 1, secToTick(n.start + (n.dur || 0.3)));
    const vel = n.velocity || 96;
    ev1.push({ tick: on, bytes: [0x90, n.midi & 0x7f, vel & 0x7f] });
    ev1.push({ tick: off, bytes: [0x80, n.midi & 0x7f, 0x40] });
  }
  const t1 = buildTrack(ev1);

  // トラック2: 歌詞 (メタ FF 05)
  const ev2 = [];
  const enc = new TextEncoder();
  for (const l of opt.lyrics || []) {
    const bytes = Array.from(enc.encode(l.text || ''));
    ev2.push({ tick: secToTick(l.time), bytes: [0xff, 0x05, ...varLen(bytes.length), ...bytes] });
  }
  const t2 = buildTrack(ev2);

  const header = new Uint8Array(14);
  header.set([0x4d, 0x54, 0x68, 0x64], 0);                 // "MThd"
  header.set([0, 0, 0, 6], 4);
  header.set([0, 1], 8);                                    // format 1
  header.set([0, 3], 10);                                   // 3 tracks
  header.set([(ppq >> 8) & 0xff, ppq & 0xff], 12);

  const c0 = chunk('MTrk', t0), c1 = chunk('MTrk', t1), c2 = chunk('MTrk', t2);
  const all = new Uint8Array(header.length + c0.length + c1.length + c2.length);
  all.set(header, 0);
  all.set(c0, header.length);
  all.set(c1, header.length + c0.length);
  all.set(c2, header.length + c0.length + c1.length);
  return all.buffer;
}
