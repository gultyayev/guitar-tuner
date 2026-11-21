// Pitch detection worker. Receives audio chunks straight from the AudioWorklet
// (main thread not involved), keeps a rolling 4096-sample window, and posts one
// small message per hop to the UI:
//   {t:'pitch', f}  a trusted reading (5 consecutive frames agree)
//   {t:'busy'}      sound present but not trustworthy yet (pluck attack, settling)
//   {t:'none'}      silence / no clear note
// Every message also carries r (loudness, for the visuals) and a (1 = new pluck).
// Timing is counted in samples, not wall-clock, so it is identical on every device.
// Cost: ~1 ms of work per 16.7 ms hop on a desktop CPU, a few ms on a phone, all on
// this background thread. (Decimating to 24 kHz was tried: 2x cheaper, but it let
// sub-harmonic errors through, so analysis stays at the native rate.)

const N = 4096;
let sr = 48000, ring = new Float32Array(N), filled = 0;
let envRms = 0, attackLeft = 0, hist = [];

function reset() { ring.fill(0); filled = 0; envRms = 0; attackLeft = 0; hist = []; }

// YIN with a sub-harmonic check. Returns {f, rms}; f = -1 when there is no clear note.
function yin(x, sr) {
  const W = N >> 1, d = new Float32Array(W);
  let rms = 0;
  for (let i = 0; i < N; i++) rms += x[i] * x[i];
  rms = Math.sqrt(rms / N);
  if (rms < 0.006) return { f: -1, rms };
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
  if (gmin > 0.2) return { f: -1, rms };
  // Shortest period whose dip is nearly as deep as the best one.
  const lim = gmin + 0.04; let tau = -1;
  for (let t = tMin; t <= tMax; t++) {
    if (d[t] <= lim) { while (t + 1 <= tMax && d[t + 1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 1) return { f: -1, rms };
  // While a note settles, 2-3 cycles can match better than 1 (reads as 1/2 or 1/3
  // of the real pitch). If a 1/k period also matches well, prefer it.
  for (const k of [4, 3, 2]) {
    const c0 = tau / k; if (c0 < tMin) continue;
    let bt = -1, bv = 1e9;
    for (let t = Math.floor(c0 - 3); t <= Math.ceil(c0 + 3); t++) if (d[t] < bv) { bv = d[t]; bt = t; }
    if (bv < 0.25 && bv < 3 * d[tau]) { tau = bt; break; }
  }
  const a = d[tau - 1], b = d[tau], c = d[tau + 1] ?? b, den = a + c - 2 * b;
  const shift = den ? (a - c) / (2 * den) : 0;
  return { f: sr / (tau + shift), rms };
}

function chunk(x) {
  const ms = x.length / sr * 1000;
  ring.copyWithin(0, x.length);
  ring.set(x, N - x.length);
  filled = Math.min(N, filled + x.length);
  if (filled < N) return;
  const { f, rms } = yin(ring, sr);
  // Every message carries the loudness (r) for the visuals; a=1 marks a new pluck.
  let a = 0;
  // A new pluck is a sudden jump in loudness: skip its noisy, sharp attack.
  if (rms > envRms * 2.2 && rms > 0.02) { attackLeft = 150; hist = []; a = 1; }
  envRms = envRms * 0.9 + rms * 0.1;
  const r = Math.round(rms * 1e4) / 1e4;
  if (attackLeft > 0) { attackLeft -= ms; postMessage({ t: 'busy', r, a }); return; }
  if (f < 60 || f > 1000) { hist = []; postMessage({ t: 'none', r, a }); return; }
  hist.push(f); if (hist.length > 5) hist.shift();
  if (hist.length < 5) { postMessage({ t: 'busy', r, a }); return; }
  // Trust a reading only once the last 5 frames (~85 ms) agree within 35 cents.
  const s = [...hist].sort((p, q) => p - q);
  if (1200 * Math.log2(s[4] / s[0]) > 35) { postMessage({ t: 'busy', r, a }); return; }
  postMessage({ t: 'pitch', f: s[2], r, a });
}

onmessage = e => {
  const m = e.data;
  if (m.t === 'init') {
    sr = m.sr; reset();
    m.port.onmessage = ev => chunk(ev.data);
  }
};
