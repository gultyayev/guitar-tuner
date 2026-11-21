# Guitar Tuner: notes for Claude

Offline PWA guitar tuner (standard tuning, A4 = 440 Hz) with automatic string detection.
Static files, no build step, deployed by GitHub Pages from `main` (repo root) to
https://gultyayev.github.io/guitar-tuner/. Every push to `main` is a release.

## Quick rules

- **Bump `VERSION` in `sw.js` on every release.** Otherwise installed apps keep the old cache.
- **Run `node tools/eval.mjs` before pushing any change to `tuner-worker.js`.** It must say "All checks passed".
- **Never add a fixed loudness threshold to the detector.** Loudness is always judged relative to the learned room floor (see Lessons).
- **Don't guess at behaviour reports from the phone.** Ask for a diagnostics capture (tap the title 5×, "Record 8 s"), add it to `recordings/`, reproduce it in `tools/eval.mjs`, then fix.
- **Don't commit `recordings/`** (gitignored). The repo is public and the captures are the owner's private audio.

## Architecture

| File | Runs on | Job |
|---|---|---|
| `tuner-worklet.js` | audio render thread | batches mic samples into ~16 ms hops, transfers them to the worker over a `MessageChannel` |
| `tuner-worker.js` | Web Worker | pitch detection and every decision about whether a reading can be trusted |
| `fx.js` | Web Worker on an `OffscreenCanvas` (falls back to the main thread) | rising "light dust" background |
| `index.html` | main thread | UI only: string choice, needle spring, readout, watchdog, diagnostics panel |
| `sw.js` | service worker | offline cache and updates |

Audio never passes through the main thread: worklet → worker directly. The main thread forwards
loudness to the fx worker and draws. Keep it that way; the UI must stay at 60 fps.

### Message protocol (worker → page)

`{t:'pitch'|'busy'|'none', f?, r, a, dbg?}`: `f` = trusted frequency, `r` = loudness above the
room (0..1, for visuals), `a` = 1 on a new pluck, `dbg` only while diagnostics are open.
Plus `{t:'recdone', sr, data}` for the 8 s capture.

## Detector (`tuner-worker.js`)

YIN on a 4096-sample window at the native rate, then a chain of gates. The constants at the top
of the file were chosen against the real recordings; change them only with `tools/eval.mjs` open.

1. **Room floor:** falls fast to quiet moments. Rises quickly between notes (`RISE_IDLE`), so a
   steady hum becomes background, and slowly during notes (`RISE`). It starts at 5% of the first frame.
2. **Pluck detection:** a jump of 8 dB+ over the quietest of the last ~80 ms, with SNR > 8.
   There's one trigger per pluck (`REFRACT_MS`), and the noisy attack is skipped (`ATTACK_MS`).
3. **Readings only inside a plucked note** (`armed`), which ends after 0.5 s of nothing.
4. **Sub-harmonic check inside YIN:** prefer the 1/k period if it matches nearly as well.
5. **Stability:** `STAB` frames must agree within `SPREAD` cents.
6. **Continuity:** a ×2/×3/×4 or ½/⅓/¼ jump within one pluck is held back unless it persists
   `JUMP_HOLD` frames.

### Lessons: don't undo these

- **Fixed level gates broke the phone.** Voice Memos recordings are boosted; the app asks for the raw
  mic (no AGC), which can be 20 dB+ quieter. A fixed `rms < 0.006` gate made the high E invisible.
  Everything must be relative to the room floor.
- **The floor must not rise during notes or attacks.** Otherwise it climbs during continuous
  playing (it once rose 18 dB in 21 s) and the tuner starts "ignoring" strings.
- **Sympathetic strings are real.** Plucking the high E sets the open A ringing (A2's 3rd partial is
  330 Hz). The mix repeats at 110 Hz and YIN reads ⅓ of the pitch. The continuity rule fixes this;
  a looser sub-harmonic rule (`SUB_ABS` > 0) fixes it too, but misreads the low E an octave up.
- **4-frame stability let a ⅓ error through on a real recording;** 5 within 25 c doesn't.
- **Tried and rejected:** decimating to 24 kHz (2× cheaper, but let sub-harmonic errors through and
  read G an octave low at 44.1 kHz); a "string being muted" detector (added up to 330 ms of
  latency, fixed nothing the stability gate didn't); octave-folding the cents for a locked string
  (turned ⅓-pitch junk into a fake +500 c).
- **A 100 Hz mains buzz exists in the owner's room** (Poland, 50 Hz mains). Pluck-gating keeps it out.

## UI (`index.html`, `fx.js`)

- Themes come from `prefers-color-scheme` via CSS variables; the dust colours are `--dust-*`.
  There's no theme switch.
- The iOS status bar is set to `default`. `black-translucent` puts white text over the light theme,
  and the iOS status-bar blur covered the title.
- The gauge maps ±50 c to ±90°. The needle uses a spring on the main thread's frame clock. There's
  no extra smoothing of readings: double smoothing felt like lag.
- The dust thins out over the readout (`clear` factor in `fx.js`). It bursts on `a`, turns mint
  when in tune, and becomes a still sprinkle under `prefers-reduced-motion`.
- The icon is `icons/icon.svg` rendered to PNGs with `rsvg-convert`. iOS caches the home-screen icon
  at install, so a new icon needs the app removed and re-added.

## Service worker (`sw.js`)

- Network-first with `cache: 'no-cache'` (GitHub Pages sends `max-age=600`), falling back to the
  cache after 3 s. The precache uses `cache: 'reload'`.
- Pages reload once on `controllerchange` and check for updates whenever they come to the
  foreground, because iOS resumes home-screen apps instead of reloading them.
- **Never `await client.navigate()` inside `activate`'s `waitUntil`.** The navigation waits for
  activation, so it deadlocks.

## Testing

```bash
node tools/eval.mjs            # detector: synthetic suite + recordings/*.wav (~40 s)
node tools/eval.mjs --verbose  # also list each wrong reading
```

To add a recording, convert it to `recordings/<name>.wav`
(`ffmpeg -i in.m4a -ac 1 -ar 48000 -c:a pcm_s16le recordings/<name>.wav`).

For an end-to-end check, run real Chrome with a recording as the mic:
serve the repo root (`python3 -m http.server`), then launch Chrome or Playwright with
`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=recordings/x.wav`.
Headless Chrome keeps the `AudioContext` suspended until the first click.
Check frame gaps with a `requestAnimationFrame` loop; all frames should land at 16.7 ms.

Things that can only be verified on an iPhone: the status bar and safe areas, mic levels and
constraints (the diagnostics panel shows what was applied), and whether audio starts without a tap.

## Conventions

- Commits are authored as `Sergey Gultyayev <22374911+gultyayev@users.noreply.github.com>`.
- Plain JS, no dependencies, no build. Keep each file self-explanatory with short "why" comments.
- The owner prefers evidence over guesses: show measured before/after numbers when changing behaviour.
