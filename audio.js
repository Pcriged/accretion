/* audio.js: audio sources, FFT analysis, band energies and beat detection.
   Exposes a global AudioEngine (plain script, so index.html works from file://). */

class AudioEngine {
  static BINS = 256;        // log-spaced spectrum bins handed to the shader
  static F_MIN = 30;        // Hz
  static F_MAX = 16000;     // Hz
  static BASS_END = 86;     // bin index ~250 Hz
  static MID_END = 171;     // bin index ~2 kHz

  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.mode = "none";     // "none" | "file" | "mic" | "demo"
    this.trackName = "";
    this.sensitivity = 1;

    this.spectrum = new Uint8Array(AudioEngine.BINS);
    this.smoothed = new Float32Array(AudioEngine.BINS);
    this.bands = { bass: 0, mid: 0, treble: 0, level: 0 };
    this.beat = 0;
    this.bassAvg = 0;
    this.lastBeat = -1;
    this.chroma = new Float32Array(12);     // share of each note, C..B
    this.chromaRaw = new Float32Array(12);
    this.timeBuf = null;
    this.zeroBuf = new Float32Array(8192);

    this.mediaEl = new Audio();
    this.mediaEl.preload = "auto";
    this.mediaNode = null;
    this.objectUrl = null;

    this.micStream = null;
    this.micNode = null;

    this.displayStream = null;
    this.systemNode = null;
    this.onSourceEnded = null;

    this.demoBus = null;
    this.demoTimer = null;
    this.demoPaused = false;
    this.noiseBuf = null;
  }

  /* ---------- setup ---------- */

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.minDecibels = -95;
      this.analyser.maxDecibels = -15;
      this.raw = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeBuf = new Float32Array(this.analyser.fftSize);
      this.buildRanges();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  // Map each display bin to a range of FFT bins (log-spaced frequency).
  buildRanges() {
    const nyquist = this.ctx.sampleRate / 2;
    const n = this.raw.length;
    const ratio = AudioEngine.F_MAX / AudioEngine.F_MIN;
    this.ranges = [];
    for (let i = 0; i < AudioEngine.BINS; i++) {
      const f0 = AudioEngine.F_MIN * Math.pow(ratio, i / AudioEngine.BINS);
      const f1 = AudioEngine.F_MIN * Math.pow(ratio, (i + 1) / AudioEngine.BINS);
      const b0 = Math.min(n - 1, Math.floor((f0 / nyquist) * n));
      const b1 = Math.min(n, Math.max(b0 + 1, Math.ceil((f1 / nyquist) * n)));
      this.ranges.push([b0, b1]);
    }
  }

  /* ---------- sources ---------- */

  stopSource() {
    this.mediaEl.pause();
    if (this.mediaNode) this.mediaNode.disconnect();

    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micStream = null;
    }
    if (this.micNode) {
      this.micNode.disconnect();
      this.micNode = null;
    }

    if (this.systemNode) {
      this.systemNode.disconnect();
      this.systemNode = null;
    }
    if (this.displayStream) {
      this.displayStream.getTracks().forEach((t) => t.stop());
      this.displayStream = null;
    }

    this.stopDemo();
    if (this.analyser) this.analyser.disconnect();
    this.mode = "none";
  }

  async loadFile(file) {
    this.ensureContext();
    this.stopSource();

    // A media element can only be wrapped once, so reuse the node.
    if (!this.mediaNode) this.mediaNode = this.ctx.createMediaElementSource(this.mediaEl);

    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.mediaEl.src = this.objectUrl;

    this.mediaNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.mode = "file";
    this.trackName = file.name;
    await this.mediaEl.play();
  }

  async useMic() {
    this.ensureContext();
    this.stopSource();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.micStream = stream;
    this.micNode = this.ctx.createMediaStreamSource(stream);
    // Deliberately not connected to the speakers, to avoid feedback.
    this.micNode.connect(this.analyser);
    this.mode = "mic";
    this.trackName = "Microphone (live)";
  }

  // Captures the Windows audio mix. Chromium-based browsers expose it through
  // the screen-share picker when the user ticks "Share system audio".
  async useSystemAudio() {
    this.ensureContext();
    this.stopSource();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("This browser cannot capture system audio. Try Chrome or Edge.");
    }

    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio was shared. Tick "Share system audio" in the picker and try again.');
    }

    // We only want the audio, so drop the screen video track.
    stream.getVideoTracks().forEach((t) => t.stop());

    this.displayStream = stream;
    this.systemNode = this.ctx.createMediaStreamSource(new MediaStream(audioTracks));
    // Not routed to the speakers: the mix is already audible, so this avoids doubling it.
    this.systemNode.connect(this.analyser);
    this.mode = "system";
    this.trackName = "System audio (Windows mix)";

    // If the user clicks "Stop sharing" in the browser, fall back to no source.
    audioTracks[0].onended = () => {
      if (this.mode !== "system") return;
      this.stopSource();
      if (this.onSourceEnded) this.onSourceEnded();
    };
  }

  startDemo() {
    this.ensureContext();
    this.stopSource();
    const ctx = this.ctx;

    this.noiseBuf = this.noiseBuf || this.makeNoise();

    this.demoBus = ctx.createGain();
    this.demoBus.gain.value = 0.7;
    this.demoBus.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Dotted-eighth echo on the lead for a bit of psychedelic smear.
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.36;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.45;
    this.echoIn.connect(delay);
    delay.connect(feedback).connect(delay);
    delay.connect(this.demoBus);

    const stepDur = 60 / 124 / 4; // sixteenth notes at 124 BPM
    let step = 0;
    let next = ctx.currentTime + 0.1;
    this.demoTimer = setInterval(() => {
      while (next < ctx.currentTime + 0.15) {
        this.playStep(step, next, stepDur);
        next += stepDur;
        step++;
      }
    }, 25);

    this.demoPaused = false;
    this.mode = "demo";
    this.trackName = "Demo: synthetic groove";
  }

  stopDemo() {
    if (this.demoTimer) clearInterval(this.demoTimer);
    this.demoTimer = null;
    if (this.demoBus) this.demoBus.disconnect();
    this.demoBus = null;
  }

  togglePlay() {
    if (this.mode === "file") {
      if (this.mediaEl.paused) this.mediaEl.play();
      else this.mediaEl.pause();
    } else if (this.mode === "demo") {
      this.demoPaused = !this.demoPaused;
      if (this.demoPaused) this.ctx.suspend();
      else this.ctx.resume();
    }
  }

  isPlaying() {
    if (this.mode === "file") return !this.mediaEl.paused && !this.mediaEl.ended;
    if (this.mode === "demo") return !this.demoPaused;
    return this.mode === "mic";
  }

  /* ---------- per-frame analysis ---------- */

  update(dt) {
    const k = (rate) => 1 - Math.exp(-rate * dt);

    // Raw waveform: the newest samples since the last frame, for the wave layer.
    const sr = this.ctx ? this.ctx.sampleRate : 48000;
    const n = Math.min(8192, Math.max(1, Math.round(dt * sr)));
    let samples;
    if (this.analyser && this.mode !== "none") {
      this.analyser.getFloatTimeDomainData(this.timeBuf);
      const m = Math.min(n, this.timeBuf.length);
      samples = this.timeBuf.subarray(this.timeBuf.length - m);
    } else {
      samples = this.zeroBuf.subarray(0, n);
    }

    if (this.analyser && this.mode !== "none") {
      this.analyser.getByteFrequencyData(this.raw);

      for (let i = 0; i < AudioEngine.BINS; i++) {
        const [a, b] = this.ranges[i];
        let sum = 0;
        for (let j = a; j < b; j++) sum += this.raw[j];
        const v = sum / (b - a) / 255;
        const target = Math.min(1, Math.pow(v, 2.2) * this.sensitivity * 1.4);
        const cur = this.smoothed[i];
        // Fast attack, slower release, so peaks punch and decay gracefully.
        this.smoothed[i] = cur + (target - cur) * k(target > cur ? 25 : 6);
        this.spectrum[i] = Math.round(this.smoothed[i] * 255);
      }
    } else {
      this.spectrum.fill(0);
      this.smoothed.fill(0);
    }

    // Chroma: how much of each note (C..B) is sounding. Each log bin is folded
    // into its pitch class. Energy is squared and sharpened so the loudest notes
    // take the widest bands. Smoothed per note.
    const ratio = AudioEngine.F_MAX / AudioEngine.F_MIN;
    this.chromaRaw.fill(0);
    for (let i = 0; i < AudioEngine.BINS; i++) {
      const f = AudioEngine.F_MIN * Math.pow(ratio, (i + 0.5) / AudioEngine.BINS);
      const midi = 69 + 12 * Math.log2(f / 440);
      const pc = ((Math.round(midi) % 12) + 12) % 12;
      this.chromaRaw[pc] += this.smoothed[i] * this.smoothed[i];
    }
    let total = 0;
    for (let pc = 0; pc < 12; pc++) {
      this.chromaRaw[pc] = Math.pow(this.chromaRaw[pc], 1.5);
      total += this.chromaRaw[pc];
    }
    for (let pc = 0; pc < 12; pc++) {
      const target = total > 1e-6 ? this.chromaRaw[pc] / total : 1 / 12;
      const cur = this.chroma[pc];
      this.chroma[pc] = cur + (target - cur) * k(target > cur ? 25 : 8);
    }

    const avg = (from, to) => {
      let s = 0;
      for (let i = from; i < to; i++) s += this.smoothed[i];
      return s / (to - from);
    };
    const targets = {
      bass: avg(0, AudioEngine.BASS_END),
      mid: avg(AudioEngine.BASS_END, AudioEngine.MID_END),
      treble: avg(AudioEngine.MID_END, AudioEngine.BINS),
      level: avg(0, AudioEngine.BINS),
    };
    for (const key in targets) {
      const cur = this.bands[key];
      const t = targets[key];
      this.bands[key] = cur + (t - cur) * k(t > cur ? 20 : 5);
    }

    // Beat: bass energy jumping well above its recent running average.
    if (this.ctx && this.analyser && this.mode !== "none") {
      const now = this.ctx.currentTime;
      const bass = targets.bass;
      this.bassAvg += (bass - this.bassAvg) * k(0.8);
      if (bass > this.bassAvg * 1.35 + 0.04 && now - this.lastBeat > 0.22) {
        this.beat = 1;
        this.lastBeat = now;
      }
    }
    this.beat *= Math.exp(-dt * 7);

    return {
      bass: this.bands.bass,
      mid: this.bands.mid,
      treble: this.bands.treble,
      level: this.bands.level,
      beat: this.beat,
      spectrum: this.spectrum,
      samples,
      chroma: this.chroma,
    };
  }

  /* ---------- demo synth (no files needed) ---------- */

  playStep(step, t, dur) {
    const CHORDS = [
      [45, 48, 52], // Am
      [41, 45, 48], // F
      [48, 52, 55], // C
      [43, 47, 50], // G
    ];
    const chord = CHORDS[Math.floor(step / 16) % 4];
    const out = this.demoBus;

    if (step % 4 === 0) this.kick(t, out);
    if (step % 8 === 4) this.snare(t, out);
    if (step % 2 === 1) this.hat(t, out, step % 8 === 3 ? 0.07 : 0.035);
    if (step % 2 === 0) {
      const pattern = [0, 0, 12, 0, 7, 0, 12, 3];
      this.bass(t, AudioEngine.mtof(chord[0] + pattern[(step / 2) % 8]), dur * 1.8, out);
    }
    if (step % 16 === 0) this.pad(t, chord, dur * 16, out);
    if (step % 4 === 2) {
      const note = chord[Math.floor(step / 4) % 3] + 24;
      this.lead(t, AudioEngine.mtof(note), dur * 2.5, out);
    }
  }

  static mtof(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  makeNoise() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  kick(t, out) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(g).connect(out);
    osc.start(t);
    osc.stop(t + 0.4);
  }

  snare(t, out) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.7;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, 0.25);
  }

  hat(t, out, vol) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp).connect(g).connect(out);
    src.start(t, Math.random() * 1.5, 0.08);
  }

  bass(t, freq, dur, out) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp).connect(g).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  pad(t, chord, dur, out) {
    const ctx = this.ctx;
    chord.forEach((m) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = AudioEngine.mtof(m + 12);
      osc.detune.value = (Math.random() - 0.5) * 12;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.6);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      osc.connect(g).connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    });
  }

  lead(t, freq, dur, out) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(out);
    g.connect(this.echoIn);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}
