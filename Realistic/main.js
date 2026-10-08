/* main.js: wires the UI, the camera and the audio engine to the renderer. */

(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $("stage");
  const hint = $("hint");
  const trackEl = $("track");
  const playBtn = $("play");
  const fileInput = $("file");
  const micBtn = $("mic");
  const systemBtn = $("system");
  const demoBtn = $("demo");
  const hideBtn = $("hide");
  const fsBtn = $("fullscreen");
  const resetBtn = $("reset-view");
  const errorEl = $("error");
  const chordEl = $("chord");

  const PRESETS = {
    // What a real observer would see: strong beaming, near-white disc.
    physical: { gravity: 1, doppler: 1, temp: 7500, exposure: 1.0, bloom: 0.3 },
    // Beaming toned down and a cooler, orange disc, as in the films.
    cinematic: { gravity: 1, doppler: 0.15, temp: 4200, exposure: 1.6, bloom: 0.55 },
    // A hot, hungry hole: blue-white inner disc, music pours in faster.
    quasar: { gravity: 1, doppler: 1, temp: 16000, exposure: 1.0, bloom: 0.5, feed: 2 },
  };

  const DEFAULTS = {
    sens: 1, feed: 1, base: 0.5, tint: 0.85, pump: 0.6, speed: 30, orbit: 0.03, quality: 0.7,
    ...PRESETS.physical,
  };

  const VIEW = { yaw: -2.2, elev: 13, dist: 38 };   // degrees for elev, M for dist

  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    showError("Could not start WebGL 2: " + err.message);
    return;
  }
  if (!renderer.hdrSupported) {
    showError("This GPU cannot render HDR, so highlights will clip.");
  }

  const audio = new AudioEngine();
  const params = { ...DEFAULTS };
  renderer.warmUp(params.base);
  window.accretion = { audio, renderer, params };   // handy for tinkering from the console

  // The colour of the music: the chord being played. Chroma is matched against all
  // 24 major and minor triads; the root picks the hue around the full colour wheel
  // (C red, E green, G# blue...) and the match confidence sets the saturation.
  // Noise and drums match nothing well, so they stay blackbody.
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const TRIADS = [];
  for (let root = 0; root < 12; root++) {
    for (const [third, suffix] of [[4, ""], [3, "m"]]) {
      // Zero-mean template so the score is a correlation, not just loudness.
      const t = new Float32Array(12).fill(-3 / 12);
      for (const iv of [0, third, 7]) t[(root + iv) % 12] += 1;
      const norm = Math.hypot(...t);
      TRIADS.push({ root, name: NOTE_NAMES[root] + suffix, t: t.map((v) => v / norm) });
    }
  }

  const hue = [0, 0];
  const chord = { index: -1, score: 0, candidate: -1, held: 0 };
  function updateHue(chroma, dt) {
    let mean = 0;
    for (let pc = 0; pc < 12; pc++) mean += chroma[pc] / 12;
    const c = new Float32Array(12);
    for (let pc = 0; pc < 12; pc++) c[pc] = chroma[pc] - mean;
    const spread = Math.hypot(...c);

    let best = -1, bestScore = -1;
    const scores = TRIADS.map((tr, i) => {
      let dot = 0;
      for (let pc = 0; pc < 12; pc++) dot += tr.t[pc] * c[pc];
      const score = spread > 1e-6 ? dot / spread : 0;
      if (score > bestScore) { bestScore = score; best = i; }
      return score;
    });

    // Hysteresis: a new chord must clearly win, and keep winning for a moment,
    // so passing notes in the melody or bass line do not flip the colour.
    const wins = chord.index < 0 || bestScore > scores[chord.index] + 0.06;
    if (wins && best === chord.candidate) chord.held += dt;
    else chord.held = 0;
    chord.candidate = wins ? best : -1;
    if (chord.index < 0 || chord.held > 0.3) {
      chord.index = best;
      chord.held = 0;
    }
    chord.score = scores[chord.index];

    // Confidence: a good triad match, in chroma that is not flat.
    const clarity = Math.min(1, (spread * 12) / 0.25);
    const conf = Math.max(0, Math.min(1, (chord.score - 0.3) / 0.35)) * clarity;
    const a = (2 * Math.PI * TRIADS[chord.index].root) / 12;
    const x = conf * Math.cos(a);
    const y = conf * Math.sin(a);

    const k = 1 - Math.exp(-dt * 6);
    hue[0] += (x - hue[0]) * k;
    hue[1] += (y - hue[1]) * k;
    chordEl.textContent = conf > 0.15 ? TRIADS[chord.index].name : "";
  }

  // Stream width follows loudness: fast swell on hits, slower relax.
  let width = 1;
  function updateWidth(level, beat, dt) {
    const target = 0.3 + 2.4 * Math.min(1, level * 2.2) + 0.5 * beat;
    const k = 1 - Math.exp(-dt * (target > width ? 14 : 3));
    width += (target - width) * k;
  }

  // The speaker cone: a damped spring kicked by beats and by swells in the bass. It
  // pumps the strength of gravity, so the lensing thumps outward on every kick
  // and recoils past rest before settling.
  const cone = { x: 0, v: 0, bassAvg: 0, kick: 0, fluxAvg: 0, fluxPeak: 0.01 };
  const prevLow = new Float32Array(48);

  // Kick detector: sudden rises of energy in the lowest bins (spectral flux),
  // measured against its own recent average and peak so it adapts to any track.
  function detectKick(spectrum, dt) {
    let flux = 0;
    for (let i = 0; i < prevLow.length; i++) {
      const v = spectrum[i] / 255;
      flux += Math.max(0, v - prevLow[i]);
      prevLow[i] = v;
    }
    flux /= prevLow.length * Math.max(dt * 60, 0.25);    // per 60 fps frame
    cone.fluxAvg += (flux - cone.fluxAvg) * (1 - Math.exp(-dt * 2));
    cone.fluxPeak = Math.max(cone.fluxPeak * Math.exp(-dt * 0.3), flux, 0.01);
    const onset = Math.max(0, flux - 1.4 * cone.fluxAvg) / cone.fluxPeak;
    cone.kick = Math.min(1, Math.max(cone.kick * Math.exp(-dt * 12), onset * 1.5));
  }
  window.accretion.cone = cone;
  function updateCone(bass, beat, dt) {
    const w = 2 * Math.PI * 3.5;       // natural frequency of the cone, rad/s
    const zeta = 0.3;                  // light damping, so it overshoots
    // Only changes in bass push the cone, so it rests at true gravity between hits.
    cone.bassAvg += (bass - cone.bassAvg) * (1 - Math.exp(-dt * 1.5));
    const target = 1.2 * cone.kick + 0.8 * (bass - cone.bassAvg) + 0.4 * beat;
    const n = 4;
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      cone.v += (w * w * (target - cone.x) - 2 * zeta * w * cone.v) * h;
      cone.x += cone.v * h;
    }
  }

  /* ---------- sliders & presets ---------- */

  function format(key, v) {
    if (key === "temp") return Math.round(v) + " K";
    if (key === "speed") return Math.round(v) + " M/s";
    return Number(v).toFixed(2);
  }

  function showValue(key) {
    const out = document.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = format(key, params[key]);
  }

  function setParam(key, value) {
    params[key] = value;
    const slider = document.querySelector(`input[data-param="${key}"]`);
    if (slider) slider.value = value;
    showValue(key);
  }

  document.querySelectorAll("input[data-param]").forEach((slider) => {
    const key = slider.dataset.param;
    slider.value = params[key];
    showValue(key);
    slider.addEventListener("input", () => {
      params[key] = parseFloat(slider.value);
      showValue(key);
    });
  });

  // Fold the controls away on phones so the hole stays visible.
  if (window.matchMedia("(max-width: 480px)").matches) {
    const details = document.querySelector("details.controls");
    if (details) details.open = false;
  }

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = { feed: DEFAULTS.feed, ...PRESETS[btn.dataset.preset] };
      for (const key in preset) setParam(key, preset[key]);
    });
  });

  /* ---------- camera: drag to orbit, scroll to zoom ---------- */

  const view = { ...VIEW };     // where the user wants the camera
  const cam = { ...VIEW };      // where it is, eased towards view
  let drag = null;

  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    view.yaw -= (e.clientX - drag.x) * 0.005;
    view.elev = Math.max(-80, Math.min(80, view.elev + (e.clientY - drag.y) * 0.25));
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.dist = Math.max(14, Math.min(90, view.dist * Math.exp(e.deltaY * 0.001)));
  }, { passive: false });

  resetBtn.addEventListener("click", () => Object.assign(view, VIEW, { yaw: cam.yaw }));

  function cameraBasis() {
    const el = (cam.elev * Math.PI) / 180;
    const pos = [
      cam.dist * Math.cos(el) * Math.cos(cam.yaw),
      cam.dist * Math.sin(el),
      cam.dist * Math.cos(el) * Math.sin(cam.yaw),
    ];
    const norm = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const cross = (a, b) => [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const fwd = norm([-pos[0], -pos[1], -pos[2]]);
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    return { pos, fwd, right, up, tanHalf: Math.tan((22 * Math.PI) / 180) };
  }

  /* ---------- sources ---------- */

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  function onSourceStarted() {
    showError("");
    hint.hidden = true;
    trackEl.textContent = audio.trackName;
    playBtn.disabled = audio.mode === "mic" || audio.mode === "system";
  }

  audio.onSourceEnded = () => {
    trackEl.textContent = "No source";
    playBtn.disabled = true;
    hint.hidden = false;
  };

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];
    fileInput.value = "";
    if (!file) return;
    try {
      await audio.loadFile(file);
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        showError("The browser blocked autoplay. Press ▶ to start.");
      } else {
        showError("Could not play that file: " + (err && err.message ? err.message : err));
      }
    }
    onSourceStarted();
  });

  micBtn.addEventListener("click", async () => {
    try {
      await audio.useMic();
      onSourceStarted();
    } catch (err) {
      showError("Microphone unavailable: " + (err && err.message ? err.message : err));
    }
  });

  systemBtn.addEventListener("click", async () => {
    try {
      await audio.useSystemAudio();
      onSourceStarted();
    } catch (err) {
      if (err && err.name === "NotAllowedError") {
        showError("Capture cancelled. Pick a screen and tick \"Share system audio\".");
      } else {
        showError("System audio unavailable: " + (err && err.message ? err.message : err));
      }
    }
  });

  demoBtn.addEventListener("click", () => {
    audio.startDemo();
    onSourceStarted();
  });

  playBtn.addEventListener("click", () => audio.togglePlay());

  /* ---------- fullscreen & UI visibility ---------- */

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  }

  function toggleUi() {
    const hidden = document.body.classList.toggle("ui-hidden");
    hideBtn.textContent = hidden ? "Show UI" : "Hide UI";
  }

  fsBtn.addEventListener("click", toggleFullscreen);
  hideBtn.addEventListener("click", toggleUi);

  window.addEventListener("keydown", (e) => {
    const tag = e.target.tagName;
    const typing = tag === "INPUT" || tag === "BUTTON" || tag === "SUMMARY";
    if (e.code === "Space" && !typing) {
      e.preventDefault();
      if (!playBtn.disabled) audio.togglePlay();
    } else if (e.key === "h" || e.key === "H") {
      toggleUi();
    } else if (e.key === "f" || e.key === "F") {
      toggleFullscreen();
    }
  });

  /* ---------- frame loop ---------- */

  const start = performance.now();
  let last = start;
  let shownPlaying = null;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    audio.sensitivity = params.sens;
    const a = audio.update(dt);
    updateHue(a.chroma, dt);
    updateWidth(a.level, a.beat, dt);
    detectKick(a.spectrum, dt);
    updateCone(a.bass, a.beat, dt);

    if (!drag) view.yaw += params.orbit * dt;
    const ease = 1 - Math.exp(-dt * 6);
    cam.yaw += (view.yaw - cam.yaw) * ease;
    cam.elev += (view.elev - cam.elev) * ease;
    cam.dist += (view.dist - cam.dist) * ease;

    renderer.render({
      time: (now - start) / 1000,
      dtM: dt * params.speed,
      spectrum: a.spectrum,
      level: a.level,
      treble: a.treble,
      beat: a.beat,
      feed: params.feed,
      base: params.base,
      injPhi: 0,
      hue,
      tint: params.tint,
      width,
      camera: cameraBasis(),
      gravity: params.gravity * Math.max(0, 1 + params.pump * cone.x),
      doppler: params.doppler,
      temp: params.temp,
      exposure: params.exposure * (1 + 0.15 * a.beat),
      bloom: params.bloom,
      quality: params.quality,
    });

    const playing = audio.isPlaying();
    if (playing !== shownPlaying) {
      shownPlaying = playing;
      playBtn.textContent = playing ? "❚❚" : "▶";
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
