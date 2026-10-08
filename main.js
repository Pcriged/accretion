/* main.js: wires the UI to the audio engine and the renderer. */

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
  const errorEl = $("error");

  const PRESETS = {
    singularity: { sens: 1.0, lens: 0.9, psy: 0.5, trail: 0.7, wave: 1.0, hue: 1.0 },
    horizon: { sens: 1.0, lens: 1.1, psy: 0.1, trail: 0.5, wave: 0.6, hue: 0.2 },
    acid: { sens: 1.1, lens: 0.5, psy: 1.0, trail: 0.9, wave: 1.4, hue: 1.6 },
  };

  let renderer;
  try {
    renderer = new Renderer(canvas);
  } catch (err) {
    showError("Could not start WebGL 2: " + err.message);
    return;
  }

  const audio = new AudioEngine();
  const wave = new WaveLayer();
  const params = { ...PRESETS.singularity };

  /* ---------- sliders & presets ---------- */

  const sliders = document.querySelectorAll("input[data-param]");

  function showValue(key) {
    const out = document.querySelector(`output[data-for="${key}"]`);
    if (out) out.textContent = Number(params[key]).toFixed(2);
  }

  function setParam(key, value) {
    params[key] = value;
    const slider = document.querySelector(`input[data-param="${key}"]`);
    if (slider) slider.value = value;
    showValue(key);
  }

  sliders.forEach((slider) => {
    const key = slider.dataset.param;
    slider.value = params[key];
    showValue(key);
    slider.addEventListener("input", () => {
      params[key] = parseFloat(slider.value);
      showValue(key);
    });
  });

  // Fold the controls away on phones so the horizon stays visible.
  if (window.matchMedia("(max-width: 480px)").matches) {
    const details = document.querySelector("details.controls");
    if (details) details.open = false;
  }

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const preset = PRESETS[btn.dataset.preset];
      for (const key in preset) setParam(key, preset[key]);
    });
  });

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
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    audio.sensitivity = params.sens;
    const a = audio.update(dt);
    wave.feed(a.samples, a.chroma, a.level);

    renderer.render({
      time: (now - start) / 1000,
      bass: a.bass,
      mid: a.mid,
      treble: a.treble,
      level: a.level,
      beat: a.beat,
      spectrum: a.spectrum,
      rs: 0.13 * (1 + 0.12 * a.bass + 0.18 * a.beat),   // matches the shader's horizon
      lens: params.lens,
      psy: params.psy,
      trail: params.trail,
      hue: params.hue,
      waveLayer: wave,
      waveStrength: params.wave,
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
