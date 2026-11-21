// Pitch detection worker. Receives audio chunks straight from the AudioWorklet
// (main thread not involved), keeps a rolling 4096-sample window, and posts one
// small message per hop to the UI:
//   {t:'pitch', f}  a trusted reading (5 consecutive frames agree)
//   {t:'busy'}      sound present but not trustworthy yet (pluck attack, settling)
//   {t:'none'}      silence / no clear note
// Every message also carries r (loudness above the room, 0..1, for the visuals) and a (1 = new pluck).
// Timing is counted in samples, not wall-clock, so it is identical on every device.
// Cost: ~1 ms of work per 16.7 ms hop on a desktop CPU, a few ms on a phone, all on
// this background thread. (Decimating to 24 kHz was tried: 2x cheaper, but it let
// sub-harmonic errors through, so analysis stays at the native rate.)

const N = 4096;
let sr = 48000, ring = new Float32Array(N), filled = 0;
// Tuning constants (evaluated against real recordings; see README).
const STAB = 5;          // frames that must agree before a reading is trusted (~83 ms)
const SPREAD = 25;       // ...within this many cents
const ATTACK_MS = 100;   // skip this long after a pluck starts
const REFRACT_MS = 300;  // a pluck can't re-trigger for this long (its loudness keeps rising)
const RISE = 1.002;      // room-floor rise per hop during a note's quiet gaps (doubles in ~6 s)
const RISE_IDLE = 1.02;  // ...and between notes, so a steady hum becomes background in ~1-2 s
const SUB_ABS = 0;       // >0 lets a clean 1/k period win outright; 0.1+ misreads low E an octave up
const JUMP_HOLD = 15;    // frames a harmonic jump (x2, x3, /2, /3) must persist before it's believed

let attackLeft = 0, sinceAttack = 1e9, hist = [], floor = 0, gaps = 0, est = 0, jumpN = 0, armed = false, recent = [];
let debug = false, rec = null;

function reset() { ring.fill(0); filled = 0; attackLeft = 0; sinceAttack = 1e9; hist = []; floor = 0; gaps = 0; est = 0; jumpN = 0; armed = false; recent = []; }

// YIN with a sub-harmonic check. Returns {f, rms}; f = -1 when there is no clear note.
function yin(x, sr) {
  const W = N >> 1, d = new Float32Array(W);
  let rms = 0;
  for (let i = 0; i < N; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / N);
  if (rms < 1e-6) return { f: -1, rms, g: 1 };   // digital silence
  const tMin = Math.floor(sr / 1000), tMax = Math.min(W - 1, Math.floor(sr / 60));
  for (let t = 1; t <= tMax; t++) {
    let s = 0;
    for (let i = 0; i < W; i++) { const v = x[i] - x[i + t]; s += v * v; }
    d[t] = s;
  }
  let run = 0; d[0] = 1;
  for (let t = 1; t <= tMax; t++) { run += d[t]; d[t] = d[t] * t / (run || 1); }
  // How periodic is the signal at all?
  let gmin = 1e9;
  for (let t = tMin; t <= tMax; t++) if (d[t] < gmin) gmin = d[t];
  if (gmin > 0.2) return { f: -1, rms, g: gmin };
  // Shortest period whose dip is nearly as deep as the best one.
  const lim = gmin + 0.04; let tau = -1;
  for (let t = tMin; t <= tMax; t++) {
    if (d[t] <= lim) { while (t + 1 <= tMax && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 1) return { f: -1, rms, g: gmin };
  // While a note settles, or when another string rings in sympathy, 2-3 cycles can match
  // better than 1 (reads as 1/2 or 1/3 of the real pitch). If a 1/k period also matches
  // well, prefer it.
  for (const k of [4, 3, 2]) {
    const c0 = tau / k; if (c0 < tMin) continue;
    let bt = -1, bv = 1e9;
    for (let t = Math.floor(c0 - 3); t <= Math.ceil(c0 + 3); t++) if (d[t] < bv) { bv = d[t]; bt = t; }
    // Wins if nearly as good as the best match, or simply clean in its own right: another
    // string ringing in sympathy can make 2-3 cycles repeat better than 1.
    if (bv < 0.25 && (bv < 3 * d[tau] || bv < SUB_ABS)) { tau = bt; break; }
  }
  const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b, den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return { f: sr / (tau + shift), rms, g: gmin };
}

function chunk(x) {
  if (rec) { rec.parts.push(x.slice()); rec.n += x.length; if (rec.n >= rec.want) finishRec(); }
  const ms = x.length / sr * 1000;
  ring.copyWithin(0, x.length);
  ring.set(x, N - x.length);
  filled = Math.min(N, filled + x.length);
  if (filled < N) return;
  const { f, rms, g } = yin(ring, sr);

  // Background noise level: drops fast to quiet moments; rises quickly between notes, so a
  // steady hum (fridge, 100 Hz mains buzz) becomes background, and only slowly during a note,
  // so notes and attacks never do. It starts low, in case a string is already ringing.
  // All loudness tests are relative to it, so the tuner behaves the same whether the mic
  // delivers a loud, boosted signal or a quiet raw one.
  if (!floor) floor = rms * 0.05;
  else if (rms < floor) floor = floor * 0.7 + rms * 0.3;
  else if (!armed && sinceAttack > REFRACT_MS) floor *= RISE_IDLE;
  else if (f < 0 && sinceAttack > REFRACT_MS) floor *= RISE;
  const snr = rms / (floor || 1e-9);
  const db = 20 * Math.log10(rms + 1e-12);

  // Every message carries the loudness (r) for the visuals; a=1 marks a new pluck.
  let a = 0;
  sinceAttack += ms;
  // A pluck is a jump of 8+ dB over the quietest of the last ~80 ms, well above the room
  // (works right after a string was muted, too). One pluck = one trigger: its loudness keeps
  // climbing for a few frames, so no re-trigger for REFRACT_MS. The noisy attack is skipped.
  const quiet = recent.length ? Math.min(...recent) : rms;
  recent.push(rms); if (recent.length > 5) recent.shift();
  if (sinceAttack > REFRACT_MS && rms > quiet * 2.5 && snr > 8) {
    attackLeft = ATTACK_MS; sinceAttack = 0; hist = []; gaps = 0; est = 0; jumpN = 0; armed = true; a = 1;
  }
  const r = Math.round(Math.min(1, snr / 60) * 1e3) / 1e3;      // 0..1, independent of mic gain
  const dbg = debug ? { fr: f, g: Math.round(g * 1e3) / 1e3, db: Math.round(db), fl: Math.round(20 * Math.log10(floor + 1e-12)) } : undefined;
  const send = (t, extra) => postMessage(Object.assign({ t, r, a }, extra, dbg && { dbg }));

  if (attackLeft > 0) { attackLeft -= ms; send('busy'); return; }
  if (!armed) { send('none'); return; }
  if (f < 60 || f > 1000 || snr < 2) {
    // Tolerate brief dropouts (2 frames) instead of restarting the count on every hiccup.
    if (++gaps > 2) hist = [];
    if (gaps > 30) { est = 0; armed = false; }  // half a second of nothing: the note is over
    send('none'); return;
  }
  gaps = 0;
  hist.push(f); if (hist.length > STAB) hist.shift();
  if (hist.length < STAB) { send('busy'); return; }
  // Trust a reading only once the last STAB frames agree within SPREAD cents.
  const s = [...hist].sort((p, q) => p - q);
  if (1200 * Math.log2(s[STAB - 1] / s[0]) > SPREAD) { send('busy'); return; }
  const fm = s[STAB >> 1];
  // Continuity: a string can't jump by an octave or more within one pluck. A sudden reading at
  // 1/2, 1/3, 1/4 or 2x-4x of the established note (another string ringing in sympathy, a strong
  // overtone) is held back unless it persists for JUMP_HOLD frames (~250 ms).
  if (est) {
    const r = fm / est, k = r >= 1 ? Math.round(r) : Math.round(1 / r);
    const off = Math.abs(1200 * Math.log2(r >= 1 ? r / k : r * k));
    if (k >= 2 && k <= 4 && off < 40) {
      if (++jumpN < JUMP_HOLD) { send('busy'); return; }
    }
  }
  est = fm; jumpN = 0;
  send('pitch', { f: fm });
}

// Diagnostic capture: the exact samples this worker analyses, returned as one buffer.
function finishRec() {
  const out = new Float32Array(rec.n); let o = 0;
  for (const p of rec.parts) { out.set(p, o); o += p.length; }
  rec = null;
  postMessage({ t: 'recdone', sr, data: out }, [out.buffer]);
}

onmessage = e => {
  const m = e.data;
  if (m.t === 'init') {
    sr = m.sr; reset();
    m.port.onmessage = ev => chunk(ev.data);
  } else if (m.t === 'debug') debug = m.on;
  else if (m.t === 'rec') rec = { parts: [], n: 0, want: Math.round(m.seconds * sr) };
};
