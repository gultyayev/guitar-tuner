# Guitar Tuner

Offline-capable guitar tuner (PWA) with automatic string detection for standard tuning (E A D G B E, A4 = 440 Hz).

- Starts listening on load. Browsers may hold audio until the first tap; then any tap on the page starts it. A Retry button appears only if the mic fails.
- Readings start only on a pluck (a sudden 8 dB+ rise), so a steady hum (100 Hz mains buzz, a fridge) is never read as a note.
- A string can't jump an octave within one pluck: sudden x2/x3 or 1/2, 1/3 readings (another string ringing in sympathy, a strong overtone) are held back unless they persist for ~250 ms.
- Works at any mic level: loudness is judged against a continuously learned room-noise floor, not a fixed threshold.
- Diagnostics: tap the title 5 times for live mic/detector stats and an 8 s capture (WAV) of exactly what the detector hears.
- Follows the system light/dark setting; honours reduced motion (dust becomes a still sprinkle).
- Auto-detect picks the nearest string; tap a string to lock it, tap again to unlock.
- Install: open the Pages URL, then **Share → Add to Home Screen** (iOS) or **Install app** (Android/desktop Chrome). Works offline after the first load.

## How it's built

No build step; static files served from the repo root.

| File | Thread | Job |
|---|---|---|
| `tuner-worklet.js` | audio render thread | batches mic samples into ~16 ms chunks, transfers them to the worker |
| `tuner-worker.js` | Web Worker | YIN pitch detection with a sub-harmonic check, pluck-attack skip, 5-frame stability gate |
| `fx.js` | Web Worker (OffscreenCanvas), main-thread fallback | rising light-dust background that reacts to plucks and turns mint in tune |
| `index.html` | main thread | string choice and drawing only |
| `sw.js` | service worker | offline cache (stale-while-revalidate); bump `VERSION` on release |

The worklet talks to the worker over a `MessageChannel`, so audio never passes through the UI thread.

## Tuning the detector

The constants at the top of `tuner-worker.js` were chosen against real recordings (iPhone and macOS, all six strings): zero wrong readings, first reading ~167 ms after a pluck, identical results from 100% down to 1% input level.
