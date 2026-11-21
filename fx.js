// Rising light dust ("Milky Way") behind the tuner.
// Runs in its own worker on an OffscreenCanvas where the browser supports it,
// otherwise on the main thread. Same code either way.
//
// Inputs:  level(rms, attack)  mic loudness each ~16 ms; attack=1 on a new pluck
//          tune(state)         'ok' | 'off' | 'idle'
//          celebrate()         a string was just tuned
//          theme(colors), resize(w, h, dpr), reduced(bool), start(), pause()
(function () {
  function createDust(canvas) {
    const g = canvas.getContext('2d');
    const hasRAF = typeof requestAnimationFrame === 'function';
    const raf = hasRAF ? f => requestAnimationFrame(f) : f => setTimeout(() => f(performance.now()), 16);
    const caf = hasRAF ? id => cancelAnimationFrame(id) : id => clearTimeout(id);

    let W = 1, H = 1, DPR = 1, loop = 0, last = 0, running = false, reducedMotion = false;
    let colors = { mode: 'dark', a: '#fff4e0', b: '#b8d0ff', ok: '#7dffd4' }, sprites = null;
    const P = [], MAX = 900;
    let energy = 0, boost = 0, okGlow = 0, tuneState = 'idle', band = Math.random() * 6.28, acc = 0;

    const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
    function sprite(col) { // soft round glow, rendered once per colour, then just blitted
      const s = 64;
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(s, s)
        : Object.assign(document.createElement('canvas'), { width: s, height: s });
      const x = c.getContext('2d'), gr = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      gr.addColorStop(0, rgba(col, 1)); gr.addColorStop(0.16, rgba(col, 0.95));
      gr.addColorStop(0.4, rgba(col, 0.28)); gr.addColorStop(1, rgba(col, 0));
      x.fillStyle = gr; x.fillRect(0, 0, s, s); return c;
    }
    const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283 * v); };

    // Dust rises along a soft diagonal band (bottom-left to top-right), like the Milky Way;
    // a third of it rises anywhere. Burst dust starts in the lower half so a pluck shows at once.
    function spawn(burst, kind) {
      if (P.length >= MAX) return;
      const inBand = Math.random() < 0.68;
      const x = inBand ? W * (0.2 + 0.08 * Math.sin(band)) + gauss() * W * 0.1 : Math.random() * W;
      const speed = (burst ? 1.7 : 1) * (16 + Math.random() * 30) * (H / 800);
      P.push({
        x, y: burst ? H * (0.55 + Math.random() * 0.5) : H + 6 * DPR,
        vx: speed * (W * 0.42 / H) * (0.75 + Math.random() * 0.5), vy: -speed,
        // 60% fine specks (drawn as single dots), 40% glowing motes
        r: (Math.random() < 0.6 ? 0.35 + Math.random() * 0.5 : 0.6 + Math.pow(Math.random(), 3) * 2.1) * DPR * (burst ? 1.2 : 1),
        a: (0.3 + Math.random() * 0.6) * (burst ? 1 : 0.85),
        tw: Math.random() * 6.28, tws: 1 + Math.random() * 3, wob: Math.random() * 6.28, wobs: 0.3 + Math.random() * 0.8,
        c: kind || (Math.random() < 0.65 ? 'a' : 'b'), k: Math.random(), life: 0,
      });
    }

    function frame(t) {
      loop = raf(frame);
      const dt = Math.min(0.05, (t - last) / 1000 || 0.016); last = t;
      energy *= Math.exp(-dt * 2.2); boost *= Math.exp(-dt * 1.3);
      okGlow += ((tuneState === 'ok' ? 1 : 0) - okGlow) * Math.min(1, dt * 2.5);
      band += dt * 0.04;
      acc += (14 + energy * 180) * dt;             // steady drizzle, much heavier while a string rings
      while (acc >= 1) { spawn(false); acc--; }
      const sp = 1 + boost * 2.4;
      for (let i = P.length - 1; i >= 0; i--) {
        const p = P[i];
        p.life += dt; p.wob += p.wobs * dt; p.tw += p.tws * dt;
        p.x += (p.vx * sp + Math.sin(p.wob) * 5 * DPR) * dt;
        p.y += p.vy * sp * dt;
        if (p.y < -12 * DPR || p.x > W + 24 * DPR) P.splice(i, 1);
      }
      draw();
    }

    function draw() {
      g.clearRect(0, 0, W, H);
      const dark = colors.mode === 'dark';
      g.globalCompositeOperation = dark ? 'lighter' : 'source-over';
      for (const p of P) {
        const yn = p.y / H;
        const fade = Math.min(1, (1 - yn) * 5 + 0.1) * Math.min(1, yn * 4) * Math.min(1, p.life * 3);
        // Keep the readout clear: dust thins out over the middle of the screen.
        const dx = p.x / W - 0.5, dy = yn - 0.45;
        const clear = Math.min(1, 0.28 + dx * dx * 5 + dy * dy * 7);
        const tw = 0.62 + 0.38 * Math.sin(p.tw);
        const alpha = p.a * fade * clear * tw;
        if (alpha < 0.012) continue;
        g.globalAlpha = Math.min(1, alpha);
        const key = (p.c === 'ok' || p.k < okGlow * 0.85) ? 'ok' : p.c;
        if (p.r < 0.9 * DPR) {             // fine speck: a single soft dot, no glow
          g.fillStyle = colors[key];
          const s = p.r * 2;
          g.fillRect(p.x - p.r, p.y - p.r, s, s);
        } else {
          const s = p.r * 6;
          g.drawImage(sprites[key], p.x - s / 2, p.y - s / 2, s, s);
        }
      }
      g.globalAlpha = 1;
    }

    function still() { // reduced motion: a quiet, static sprinkle
      P.length = 0;
      for (let i = 0; i < 240; i++) { spawn(false); const p = P[P.length - 1]; p.y = Math.random() * H; p.life = 1; p.x = Math.random() * W; }
      draw();
    }

    const api = {
      resize(w, h, dpr) {
        DPR = dpr; W = Math.max(1, Math.round(w * dpr)); H = Math.max(1, Math.round(h * dpr));
        canvas.width = W; canvas.height = H;
        if (reducedMotion && sprites) still();
      },
      theme(c) { colors = c; sprites = { a: sprite(c.a), b: sprite(c.b), ok: sprite(c.ok) }; if (reducedMotion) still(); },
      reduced(v) { reducedMotion = v; if (v) { api.pause(); if (sprites) still(); } },
      start() {
        if (running || reducedMotion) return;
        running = true; last = performance.now();
        if (!P.length) for (let i = 0; i < 220; i++) { spawn(false); const p = P[P.length - 1]; p.y = Math.random() * H; p.life = 1; }
        loop = raf(frame);
      },
      pause() { running = false; caf(loop); },
      level(rms, attack) {
        const v = Math.min(1, rms);           // already 0..1: loudness above the room
        if (v > energy) energy = v;
        if (attack && !reducedMotion) {
          boost = Math.min(1, boost + 0.35 + v * 0.65);
          const n = Math.round(30 + v * 120);
          for (let i = 0; i < n; i++) spawn(true);
        }
      },
      tune(s) { tuneState = s; },
      celebrate() { if (!reducedMotion) for (let i = 0; i < 90; i++) spawn(true, 'ok'); },
    };
    return api;
  }

  if (typeof window === 'undefined') {     // worker: drive it from messages
    let fx = null;
    onmessage = e => {
      const m = e.data;
      if (m.t === 'init') {
        fx = createDust(m.canvas);
        fx.theme(m.colors); fx.resize(m.w, m.h, m.dpr); fx.reduced(m.reduced); fx.start();
        postMessage({ t: 'ready' });
      } else if (fx && fx[m.t]) fx[m.t](...(m.a || []));
    };
  } else {
    window.createDust = createDust;        // main-thread fallback
  }
})();
