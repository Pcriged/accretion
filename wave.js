/* wave.js: the audio stream. The path is one spiral arm: it starts just off the
   left edge, winds inward around the hole and is swallowed at the horizon.
   It is drawn unlensed, over the lensed disc and background.
   The stream is a rainbow: each of the 12 notes (C..B) is a band across its width,
   as wide as that note's share of the sound when that slice of audio entered.
   The shares are kept as the stream stretches and spirals in.
   This file lays the stream out as triangle geometry; renderer.js draws it.
   Exposes a global WaveLayer. */

// HSL to RGB (0..255). h in degrees.
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function smoothstepJS(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

class WaveLayer {
  static HIST = 1024;        // points along the path, newest first
  static DECIM = 24;         // raw samples averaged into each point
  static NOTES = 12;         // pitch classes, C..B: one rainbow band each
  static TURNS = 1.75;       // spiral turns from the left edge to the horizon
  static R_MAX = 1.0;        // radius covered by the disc colour lookup
  static BINS = 256;         // radius resolution of the disc lookup
  static SQUASH = 3.4;       // matches the disc tilt in the shader
  static WIDTH = 0.034;      // full stream width in world units, before tapering
  static HALO_WIDTH = 2.2;   // the soft glow is this many times wider than the stream
  static HALO_ALPHA = 0.22;  // and this much fainter
  static FLOATS = 6;         // per vertex: x, y (clip space), r, g, b, a

  constructor() {
    const n = WaveLayer.HIST;
    const k = WaveLayer.NOTES;

    // Per history point, indexed by ring position.
    this.value = new Float32Array(n);        // waveform value, -1..1
    this.chroma = new Float32Array(n * k);   // note shares, sum to 1
    this.level = new Float32Array(n);        // loudness, 0..1
    this.head = 0;                           // index of the newest point
    this.accSum = 0;
    this.accN = 0;

    // Layout for the current frame, indexed by path position (0 = newest).
    this.wx = new Float32Array(n);           // world units (isotropic, 1 unit = screen height)
    this.wy = new Float32Array(n);
    this.nx = new Float32Array(n);           // unit normal across the stream
    this.ny = new Float32Array(n);
    this.halfW = new Float32Array(n);        // half stream width, world units
    this.alpha = new Float32Array(n);
    this.radius = new Float32Array(n);       // unlensed disc radius of each point
    this.cum = new Float32Array(n * k);      // cumulative note shares across the width

    // Vertex data for the glow and core passes: two vertices per point per note.
    this.halo = new Float32Array(n * k * 2 * WaveLayer.FLOATS);
    this.core = new Float32Array(n * k * 2 * WaveLayer.FLOATS);

    // Precomputed rainbow colours, one per note, as 0..1.
    this.bandRgb = [];
    for (let c = 0; c < k; c++) {
      const [r, g, b] = hslToRgb((360 * c) / k, 1, 0.55);
      this.bandRgb.push([r / 255, g / 255, b / 255]);
    }

    this.ringPixels = new Uint8Array(WaveLayer.BINS * k * 4);
  }

  // Push new raw samples from the analyser, with the note shares and loudness.
  feed(samples, chroma, level) {
    const n = WaveLayer.HIST;
    const k = WaveLayer.NOTES;
    for (let i = 0; i < samples.length; i++) {
      this.accSum += samples[i];
      if (++this.accN >= WaveLayer.DECIM) {
        this.head = (this.head + 1) % n;
        this.value[this.head] = this.accSum / this.accN;
        this.level[this.head] = level;
        this.chroma.set(chroma, this.head * k);
        this.accSum = 0;
        this.accN = 0;
      }
    }
  }

  // Vertex index for path point j, note c, side s (0 = left edge, 1 = right edge).
  static vertex(j, c, s) {
    return (j * WaveLayer.NOTES + c) * 2 + s;
  }

  // Index buffer shared by both passes: two triangles per note per segment.
  static indices() {
    const n = WaveLayer.HIST;
    const K = WaveLayer.NOTES;
    const idx = new Uint32Array((n - 1) * K * 6);
    let o = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let c = 0; c < K; c++) {
        const a = WaveLayer.vertex(j, c, 0);
        const b = WaveLayer.vertex(j, c, 1);
        const d = WaveLayer.vertex(j + 1, c, 0);
        const e = WaveLayer.vertex(j + 1, c, 1);
        idx.set([a, b, d, b, e, d], o);
        o += 6;
      }
    }
    return idx;
  }

  static indexCount() {
    return (WaveLayer.HIST - 1) * WaveLayer.NOTES * 6;
  }

  // Lay the stream out along the spiral and fill the vertex data for both passes,
  // plus the disc colour lookup. rs: horizon radius this frame, amp: wiggle size in
  // world units, strength: overall brightness from the Wave slider.
  layout(W, H, rs, amp, strength) {
    const n = WaveLayer.HIST;
    const K = WaveLayer.NOTES;
    const xLeft = -(W / H) / 2;
    const Rout = Math.abs(xLeft) * 1.02;     // the arm starts just off the left edge
    const rEnd = rs * 1.15;                  // the stream is gone just outside the horizon
    const spiralLen = 2 * Math.PI * WaveLayer.TURNS;
    const sq = WaveLayer.SQUASH;

    // ---- 1) points along the spiral ----
    for (let j = 0; j < n; j++) {
      const idx = (this.head - j + n) % n;
      const w = this.value[idx];
      const v = j / (n - 1);                   // 0 = newest (off the left edge), 1 = horizon
      const lvl = Math.min(1, this.level[idx] * 4);   // quiet sound: thinner, dimmer

      const r0 = Rout * Math.pow(rEnd / Rout, v);
      const r = r0 + w * amp * (1 - 0.7 * v);  // the waveform rides the arm
      const th = Math.PI + spiralLen * v;
      let x = r * Math.cos(th);
      let y = (r * Math.sin(th)) / sq;

      // Upper half = behind the hole. Blended across the horizontal axis.
      const back = smoothstepJS(-0.03, 0.03, y);
      this.wx[j] = x;
      this.wy[j] = y;
      this.radius[j] = r;

      // Light from the far side inside the shadow is hidden; fade in at the entry,
      // and fade out as the arm is swallowed.
      const shadowMask = 1 - back * (1 - smoothstepJS(rs * 0.97, rs * 1.03, r));
      this.alpha[j] = Math.min(1, v / 0.04) * (1 - Math.pow(v, 3)) * shadowMask
                    * (0.35 + 0.65 * lvl) * strength;
      const taper = 1 - 0.6 * v;               // spaghettify: thins as it nears the horizon
      this.halfW[j] = 0.5 * WaveLayer.WIDTH * (0.55 + 0.45 * lvl) * taper;

      // Cumulative note shares across the width: band c spans cum[c-1]..cum[c].
      let sum = 0;
      for (let c = 0; c < K; c++) sum += this.chroma[idx * K + c];
      let acc = 0;
      for (let c = 0; c < K; c++) {
        acc += sum > 1e-6 ? this.chroma[idx * K + c] / sum : 1 / K;
        this.cum[j * K + c] = acc;
      }
      this.cum[j * K + K - 1] = 1;
    }

    // ---- 2) unit normals across the stream (world units are isotropic) ----
    for (let j = 0; j < n; j++) {
      const a = Math.max(0, j - 1);
      const b = Math.min(n - 1, j + 1);
      const tx = this.wx[b] - this.wx[a];
      const ty = this.wy[b] - this.wy[a];
      const len = Math.hypot(tx, ty) || 1;
      this.nx[j] = -ty / len;
      this.ny[j] = tx / len;
    }

    // ---- 3) vertices: world -> clip space (x = wx * 2H/W, y = wy * 2) ----
    const toX = (x) => (x * 2 * H) / W;
    const toY = (y) => y * 2;
    const put = (buf, vi, x, y, rgb, a) => {
      const o = vi * WaveLayer.FLOATS;
      buf[o] = toX(x);
      buf[o + 1] = toY(y);
      buf[o + 2] = rgb[0];
      buf[o + 3] = rgb[1];
      buf[o + 4] = rgb[2];
      buf[o + 5] = a;
    };

    for (let j = 0; j < n; j++) {
      for (let c = 0; c < K; c++) {
        const rgb = this.bandRgb[c];
        for (let s = 0; s < 2; s++) {
          const f = s === 0 ? (c === 0 ? 0 : this.cum[j * K + c - 1]) : this.cum[j * K + c];
          const vi = WaveLayer.vertex(j, c, s);
          const off = (f - 0.5) * 2;
          const hw = this.halfW[j];
          // Core stream, then a wider, fainter halo for the glow.
          put(this.core, vi,
            this.wx[j] + this.nx[j] * off * hw,
            this.wy[j] + this.ny[j] * off * hw,
            rgb, this.alpha[j]);
          put(this.halo, vi,
            this.wx[j] + this.nx[j] * off * hw * WaveLayer.HALO_WIDTH,
            this.wy[j] + this.ny[j] * off * hw * WaveLayer.HALO_WIDTH,
            rgb, this.alpha[j] * WaveLayer.HALO_ALPHA);
        }
      }
    }

    // ---- 4) disc lookup: for each radius, each note's cumulative share ----
    // Row c holds note c: rgb = its colour, alpha = cumulative share (0..1).
    const rp = this.ringPixels;
    rp.fill(0);
    for (let j = 0; j < n; j++) {
      if (this.alpha[j] < 0.01) continue;
      const bin = Math.min(WaveLayer.BINS - 1,
        Math.floor((this.radius[j] / WaveLayer.R_MAX) * WaveLayer.BINS));
      for (let c = 0; c < K; c++) {
        const [r, g, b] = this.bandRgb[c];
        const o = (c * WaveLayer.BINS + bin) * 4;
        rp[o] = r * 255;
        rp[o + 1] = g * 255;
        rp[o + 2] = b * 255;
        rp[o + 3] = this.cum[j * K + c] * 255;
      }
    }
  }
}
