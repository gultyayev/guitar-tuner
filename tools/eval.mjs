#!/usr/bin/env node
// Detector regression suite. Runs tuner-worker.js exactly as the app does (same message
// protocol, 60 chunks/s) on real recordings and on synthetic signals, and fails (exit 1)
// if anything regresses.
//
//   node tools/eval.mjs              # synthetic suite + every recordings/*.wav
//   node tools/eval.mjs --verbose    # also list every wrong reading
//
// Real recordings are NOT committed (public repo). Put them in recordings/ as WAV:
//   ffmpeg -i capture.m4a -ac 1 -ar 48000 -c:a pcm_s16le recordings/name.wav
// The diagnostics panel in the app (tap the title 5x) exports captures in this format already.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const code = readFileSync(join(root, 'tuner-worker.js'), 'utf8');
const verbose = process.argv.includes('--verbose');
const STR = [['E2', 82.41], ['A2', 110], ['D3', 146.83], ['G3', 196], ['B3', 246.94], ['E4', 329.63]];
const cents = (f, r) => 1200 * Math.log2(f / r);
const nearest = f => { let b = '?', bc = 1e9; for (const [n, r] of STR) { const c = Math.abs(cents(f, r)); if (c < bc) { bc = c; b = n; } } return bc > 60 ? '?' + f.toFixed(0) : b; };
let failures = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

// Run the worker over a mono Float32Array, chunked like the AudioWorklet does.
function run(sig, sr) {
  const out = [];
  const W = new Function('postMessage', code + ';return {onmessage}')(m => out.push(m));
  const port = {};
  W.onmessage({ data: { t: 'init', sr, port } });
  W.onmessage({ data: { t: 'debug', on: true } });
  const hop = Math.round(sr / 60);
  for (let i = 0; i + hop <= sig.length; i += hop) port.onmessage({ data: sig.slice(i, i + hop) });
  return { out, hop };
}

function readWav(path) {
  const b = readFileSync(path), v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = v.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { tag: v.getUint16(p + 8, true), ch: v.getUint16(p + 10, true), sr: v.getUint32(p + 12, true), bits: v.getUint16(p + 22, true) };
    if (id === 'data') data = [p + 8, size];
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('not a WAV file');
  const [off, size] = data, bps = fmt.bits / 8, n = Math.floor(size / bps / fmt.ch), x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = off + (i * fmt.ch + c) * bps;
      s += fmt.tag === 3 ? v.getFloat32(o, true) : bps === 2 ? v.getInt16(o, true) / 32768 : bps === 4 ? v.getInt32(o, true) / 2147483648 : (v.getUint8(o) - 128) / 128;
    }
    x[i] = s / fmt.ch;
  }
  return { x, sr: fmt.sr };
}

// Per pluck: wrong readings (>20 c off that pluck's median), latency to first reading, note.
function analyse(sig, sr) {
  const { out, hop } = run(sig, sr);
  const t = i => (i * hop + 4096) / sr;
  const starts = out.map((m, i) => (m.a ? i : -1)).filter(i => i >= 0);
  let wrong = [], lat = [], notes = [], trusted = 0;
  starts.forEach((a, k) => {
    const b = k + 1 < starts.length ? starts[k + 1] : out.length, ps = [];
    for (let i = a; i < b; i++) if (out[i].t === 'pitch') ps.push([i, out[i].f]);
    if (!ps.length) { lat.push(null); notes.push('-'); return; }
    const med = ps.map(p => p[1]).sort((x, y) => x - y)[ps.length >> 1];
    for (const [i, f] of ps) { const c = cents(f, med); if (Math.abs(c) > 20) wrong.push(`${t(i).toFixed(2)}s ${c > 0 ? '+' : ''}${c.toFixed(0)}c`); }
    lat.push(Math.round((ps[0][0] - a) * hop / sr * 1000)); notes.push(nearest(med)); trusted += ps.length;
  });
  const fl = out.map(m => m.dbg.fl);
  return { out, starts: starts.map(t), wrong, lat, notes, trusted, drift: fl[fl.length - 1] - fl[Math.min(60, fl.length - 1)] };
}

// ---------- synthetic signals ----------
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
// Plucked string (Karplus-Strong, fractional delay = exact pitch), phone-mic low cut, noise.
function pluck(f0, sr, secs = 2.5, pre = 0.5) {
  const L = sr / f0, n = Math.ceil(L) + 2, line = new Float32Array(n).map(() => rnd()), o = new Float32Array(Math.round(sr * secs));
  let w = 0;
  for (let i = Math.round(sr * pre); i < o.length; i++) {
    const r = (w - L + n * 4) % n, i0 = Math.floor(r), fr = r - i0, v = line[i0] * (1 - fr) + line[(i0 + 1) % n] * fr;
    o[i] = v; line[w] = 0.996 * v; w = (w + 1) % n;
  }
  let y = 0, pr = 0;
  for (let i = 0; i < o.length; i++) { const x = o[i]; y = 0.97 * (y + x - pr); pr = x; o[i] = y * 0.3 + rnd() * 0.002; }
  return o;
}
const tone = (sr, secs, parts, noise) => { const o = new Float32Array(Math.round(sr * secs)); for (let i = 0; i < o.length; i++) { const t = i / sr; let s = rnd() * noise; for (const [f, a, on = 0] of parts) if (t >= on) s += a * Math.sin(2 * Math.PI * f * t); o[i] = s; } return o; };
const readings = sig => run(sig, 48000).out.filter(m => m.t === 'pitch').map(m => m.f);
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

console.log('Synthetic suite');
for (const sr of [44100, 48000]) for (const [n, f0] of STR) {
  const r = run(pluck(f0, sr), sr).out.filter(m => m.t === 'pitch').map(m => m.f), m = r.length ? median(r) : NaN;
  check(r.length > 20 && Math.abs(cents(m, f0)) < 0.5, `${sr} Hz ${n}: ${r.length} readings, ${isFinite(m) ? cents(m, f0).toFixed(2) : '-'} c`);
}
{
  const r = readings(tone(48000, 32, [[329.63, 0.003, 2], [659.26, 0.0018, 2], [988.9, 0.0009, 2]], 0.0004));
  check(r.length > 1600, `steady quiet tone for 30 s keeps reading (${r.length} readings)`);
}
check(readings(tone(48000, 20, [], 0.0015)).length === 0, 'room noise alone: no readings');
check(readings(tone(48000, 10, [[50, 0.01]], 0.001)).length === 0, '50 Hz mains hum: no readings');
for (const a of [0.001, 0.004]) {
  const s = tone(48000, 14, [[100, a], [200, a / 2], [300, a / 3]], 0.0005), p = pluck(110, 48000, 4, 0);
  const hum = readings(s.subarray(0, 48000 * 10)).length;
  for (let i = 0; i < p.length; i++) s[48000 * 10 + i] += p[i] * 0.5;
  const r = readings(s), m = r.length ? median(r) : NaN;
  check(hum === 0 && Math.abs(cents(m, 110)) < 3, `100 Hz buzz at ${(20 * Math.log10(a)).toFixed(0)} dBFS: ${hum} false readings, A plucked over it reads ${isFinite(m) ? m.toFixed(2) : '-'} Hz`);
}

const dir = join(root, 'recordings');
const wavs = existsSync(dir) ? readdirSync(dir).filter(f => /\.wav$/i.test(f)) : [];
console.log(`\nRecordings (${wavs.length} in recordings/)`);
for (const f of wavs) {
  const { x, sr } = readWav(join(dir, f)), a = analyse(x, sr);
  console.log(`  ${f}: plucks at ${a.starts.map(s => s.toFixed(1)).join(', ')} s`);
  console.log(`       notes ${a.notes.join(' ')} | latency ms ${a.lat.map(l => l ?? 'never').join(' ')} | room drift ${a.drift} dB`);
  if (verbose && a.wrong.length) console.log(`       wrong: ${a.wrong.join(', ')}`);
  check(a.wrong.length === 0, `${f}: ${a.wrong.length} wrong readings`);
  check(a.lat.every(l => l != null && l <= 250), `${f}: every pluck read within 250 ms`);
  for (const g of [0.1, 0.01]) {
    const b = analyse(x.map(v => v * g), sr);
    check(b.notes.join() === a.notes.join() && b.wrong.length === 0, `${f} at ${g * 100}% level: same notes, ${b.wrong.length} wrong`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
