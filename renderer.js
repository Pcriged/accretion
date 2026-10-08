/* renderer.js: WebGL2 pipeline.
   Pass 1 draws the scene into an offscreen target while sampling the previous
   frame for feedback trails. The audio stream (triangles laid out by wave.js) is
   drawn into that same target, so it also feeds the trails. Pass 2 copies the
   target to the screen. */

const VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const SCENE_FRAG_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform float uBass, uMid, uTreble, uLevel, uBeat;
uniform float uLens, uPsy, uHue, uTrail, uTint;
uniform sampler2D uSpec;
uniform sampler2D uPrev;
uniform sampler2D uRing;      // note shares of the stream at each radius, for the disc

const float PI = 3.14159265;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return v;
}

// Cosine palette (Inigo Quilez): full rainbow cycle, the psychedelic core.
vec3 pal(float t) {
  return 0.5 + 0.5 * cos(2.0 * PI * (t + vec3(0.0, 0.33, 0.67)));
}

float spec(float x) {
  return texture(uSpec, vec2(clamp(x, 0.0, 1.0), 0.5)).r;
}

// Domain-warped nebula: the psychedelic backdrop that gets lensed by the hole.
vec3 nebula(vec2 p, float t) {
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + 0.3 * t),
                fbm(p + 3.0 * q + vec2(8.3, 2.8) - 0.2 * t));
  float f = fbm(p + 3.0 * r);
  vec3 col = pal(f * 1.4 + length(r) * 0.6 + uTime * 0.02 * uHue);
  float shade = 0.05 + 0.6 * f * f;
  vec3 base = vec3(0.03, 0.01, 0.07);
  return mix(base, col * shade, 0.35 + 0.65 * uPsy) * (1.0 + 0.8 * uMid);
}

// Gravitational lens: a point at distance r is seen where its light really comes
// from. Beyond the Einstein radius it barely moves; inside it the image swings to
// the far side. Soft at the centre so nothing blows up. Matches lens() in wave.js.
vec2 lensP(vec2 p, float rs) {
  float r = max(length(p), 1e-4);
  float E = 1.6 * rs;
  float beta = r - E * E / (r + 0.3 * rs);
  return p * (beta / r);
}

void main() {
  float t = uTime;
  // Centred coordinates, aspect-correct: y runs roughly -0.5..0.5.
  vec2 p0 = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  // Event-horizon radius breathes with bass and kicks.
  float rs = 0.13 * (1.0 + 0.12 * uBass + 0.18 * uBeat);
  float r = length(p0);

  // ---- background: slow spin, optional kaleidoscope fold ----
  float spin = t * 0.04 * uHue + 0.15 * uBass;
  vec2 pr = mat2(cos(spin), -sin(spin), sin(spin), cos(spin)) * p0;
  float seg = 2.0 * PI / floor(5.0 + 5.0 * uMid);
  float a = abs(mod(atan(pr.y, pr.x), seg) - 0.5 * seg);
  vec2 pk = length(pr) * vec2(cos(a), sin(a));
  vec2 pb = mix(pr, pk, uPsy);

  // ---- gravitational lensing: background samples are pulled around the hole ----
  vec2 pl = mix(pb, lensP(pb, rs), clamp(uLens, 0.0, 1.0));
  vec3 col = nebula(pl * 2.2, t * 0.05);

  // ---- the shadow: nothing escapes the horizon ----
  float shadow = smoothstep(rs * 0.97, rs * 1.03, r);
  col *= shadow;

  // ---- photon ring and glowing halo ----
  vec3 glowC = pal(0.58 + 0.2 * sin(t * 0.3) + 0.15 * uMid + 0.05 * (r / rs));
  float ringD = (r - rs * 1.12) / (rs * 0.05);
  float photon = exp(-ringD * ringD);
  col += mix(vec3(1.0, 0.95, 0.85), glowC, 0.25 + 0.6 * uPsy)
       * photon * (0.8 + 1.4 * uTreble + 0.8 * uBeat);
  float halo = exp(-max(r - rs, 0.0) * (9.0 - 4.0 * uBass)) * shadow;
  col += glowC * halo * (0.35 + 0.5 * uLevel + 0.5 * uBeat);

  // ---- accretion disc: tilted, turbulent, Doppler-beamed ----
  // The far side (upper half) is seen through the lens, so it bends up and over
  // the hole. The blend across the horizontal axis keeps the disc continuous.
  float back = smoothstep(-0.03, 0.03, p0.y);
  vec2 pd = mix(p0, lensP(p0, rs), back);
  vec2 e = vec2(pd.x, pd.y * 3.4);               // squash y to tilt the disc
  float d = length(e);
  float rIn = rs * 1.45;
  float rOut = rs * 4.6;
  float ud = clamp((d - rIn) / (rOut - rIn), 0.0, 1.0);
  float inDisc = smoothstep(rIn - 0.01, rIn + 0.005, d)
               * (1.0 - smoothstep(rOut - 0.03, rOut, d));
  // The lower half passes in front of the hole. Light from the far side is
  // hidden inside the shadow.
  float visible = mix(1.0, shadow, back);

  float th = atan(e.y, e.x);
  float turb = fbm(vec2(ud * 7.0 - t * 0.5 * (1.0 + uBass), th * 2.0 + ud * 3.0));
  float bands = 0.5 + 0.5 * sin(ud * 55.0 - t * 2.5 + turb * 7.0);
  float sp = spec(0.04 + ud * 0.7);              // inner disc = bass, outer = treble
  vec3 hot = mix(vec3(1.0, 0.96, 0.85), vec3(1.0, 0.42, 0.06), smoothstep(0.0, 0.35, ud));
  hot = mix(hot, vec3(0.62, 0.10, 0.95), smoothstep(0.35, 1.0, ud));

  // The disc shows the stream's rainbow as arcs: each note takes a share of the
  // ring's angle equal to its share of the stream at this radius.
  float ang = fract(th / (2.0 * PI) + 0.5 + t * 0.03);
  float xr = clamp(d / 1.0, 0.0, 1.0);
  vec3 rainbow = vec3(0.0);
  float cover = 0.0;
  for (int k = 0; k < 12; k++) {
    vec4 tx = textureLod(uRing, vec2(xr, (float(k) + 0.5) / 12.0), 0.0);
    if (cover < 0.5 && ang < tx.a) {
      rainbow = tx.rgb;
      cover = 1.0;
    }
  }
  hot = mix(hot, rainbow * 1.5, cover * clamp(uTint, 0.0, 1.0));

  float beam = pow(0.6 + 0.4 * (e.x / max(d, 1e-4)), 2.2); // approaching side is brighter
  float intensity = (0.3 + 0.7 * turb) * (0.55 + 0.45 * bands)
                  * (0.7 + 2.2 * sp + 0.5 * uLevel) * beam * (1.0 - 0.6 * ud);
  col += hot * intensity * inDisc * visible * 1.3;

  // ---- psychedelic shimmer rings riding the spectrum ----
  float rip = 0.5 + 0.5 * sin(r * 38.0 - t * 4.0 - uBass * 5.0);
  col += pal(r * 1.6 - t * 0.12) * rip * spec(r * 1.2) * 0.22 * uPsy * shadow;

  // beat flash
  col += glowC * uBeat * 0.12 * exp(-r * 2.5);

  // vignette and tone map
  col *= 1.0 - 0.7 * dot(p0, p0);
  col = 1.0 - exp(-col * (1.1 + 0.6 * uBeat));

  // ---- feedback: last frame zoomed out and twisted, screen-blended back in ----
  float zoom = 0.982 - 0.01 * uBass * uPsy;
  float twist = (0.003 + 0.006 * uMid) * uPsy;
  vec2 tp = mat2(cos(twist), -sin(twist), sin(twist), cos(twist)) * (p0 * zoom);
  vec2 tuv = tp * vec2(uRes.y / uRes.x, 1.0) + 0.5;
  vec3 prev = texture(uPrev, tuv).rgb * uTrail;
  col = col + prev - col * prev;

  fragColor = vec4(col, 1.0);
}`;

const WAVE_VERT_SRC = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aCol;
out vec4 vCol;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
  vCol = aCol;
}`;

const WAVE_FRAG_SRC = `#version 300 es
precision highp float;
in vec4 vCol;
out vec4 fragColor;
void main() {
  fragColor = vCol;
}`;

const BLIT_FRAG_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uRes;
void main() {
  fragColor = texture(uTex, gl_FragCoord.xy / uRes);
}`;

const SCENE_UNIFORMS = [
  "uRes", "uTime", "uBass", "uMid", "uTreble", "uLevel", "uBeat",
  "uLens", "uPsy", "uHue", "uTrail", "uTint", "uSpec", "uPrev", "uRing",
];

class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL 2 is not available in this browser.");
    this.canvas = canvas;
    this.gl = gl;

    this.sceneProg = this.program(VERT_SRC, SCENE_FRAG_SRC);
    this.blitProg = this.program(VERT_SRC, BLIT_FRAG_SRC);
    this.waveProg = this.program(WAVE_VERT_SRC, WAVE_FRAG_SRC);
    this.sceneU = this.uniformLocations(this.sceneProg, SCENE_UNIFORMS);
    this.blitU = this.uniformLocations(this.blitProg, ["uTex", "uRes"]);

    // One big triangle covers the whole clip space.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // The audio stream: a glow pass and a core pass, each with its own vertex
    // buffer, sharing one index buffer. Both are rebuilt by wave.js every frame.
    const stride = WaveLayer.FLOATS * 4;
    this.waveIdxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.waveIdxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, WaveLayer.indices(), gl.STATIC_DRAW);
    this.waveVaos = [];
    this.waveVbos = [];
    for (let i = 0; i < 2; i++) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.waveIdxBuf);
      this.waveVaos.push(vao);
      this.waveVbos.push(vbo);
    }
    gl.bindVertexArray(this.vao);

    // 256x1 spectrum texture, one byte per bin.
    this.spectrumTex = this.linearTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(256));

    // Disc lookup: BINS radii x NOTES rows. Nearest filtering keeps each note's
    // cumulative share exact.
    this.ringTex = this.linearTexture();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, WaveLayer.BINS, WaveLayer.NOTES, 0, gl.RGBA,
      gl.UNSIGNED_BYTE, new Uint8Array(WaveLayer.BINS * WaveLayer.NOTES * 4));

    this.targets = [null, null];
    this.index = 0;
  }

  /* ---------- GL helpers ---------- */

  linearTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  compile(type, src) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader));
    }
    return shader;
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  uniformLocations(prog, names) {
    const loc = {};
    for (const name of names) loc[name] = this.gl.getUniformLocation(prog, name);
    return loc;
  }

  makeTarget(w, h) {
    const gl = this.gl;
    const tex = this.linearTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (w === this.canvas.width && h === this.canvas.height && this.targets[0]) return;

    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;
    for (const t of this.targets) {
      if (!t) continue;
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fb);
    }
    this.targets = [this.makeTarget(w, h), this.makeTarget(w, h)];
  }

  /* ---------- frame ---------- */

  render(s) {
    const gl = this.gl;
    this.resize();

    const src = this.targets[this.index];
    const dst = this.targets[1 - this.index];

    // Pass 1: scene into dst, reading src for feedback.
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.useProgram(this.sceneProg);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.spectrumTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, s.spectrum);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.ringTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, WaveLayer.BINS, WaveLayer.NOTES, gl.RGBA,
      gl.UNSIGNED_BYTE, s.waveLayer.ringPixels);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);

    const u = this.sceneU;
    gl.uniform1i(u.uPrev, 0);
    gl.uniform1i(u.uSpec, 1);
    gl.uniform1i(u.uRing, 3);
    gl.uniform2f(u.uRes, dst.w, dst.h);
    gl.uniform1f(u.uTime, s.time);
    gl.uniform1f(u.uBass, s.bass);
    gl.uniform1f(u.uMid, s.mid);
    gl.uniform1f(u.uTreble, s.treble);
    gl.uniform1f(u.uLevel, s.level);
    gl.uniform1f(u.uBeat, s.beat);
    gl.uniform1f(u.uLens, s.lens);
    gl.uniform1f(u.uPsy, s.psy);
    gl.uniform1f(u.uHue, s.hue);
    gl.uniform1f(u.uTrail, s.trail);
    gl.uniform1f(u.uTint, s.waveStrength);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Audio stream: laid out for this frame, then drawn over the scene into dst.
    const wave = s.waveLayer;
    wave.layout(dst.w, dst.h, s.rs, 0.05, s.waveStrength);
    gl.useProgram(this.waveProg);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const passes = [[wave.halo, 0], [wave.core, 1]];
    for (const [verts, i] of passes) {
      gl.bindVertexArray(this.waveVaos[i]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.waveVbos[i]);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      gl.drawElements(gl.TRIANGLES, WaveLayer.indexCount(), gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.BLEND);

    // Pass 2: show dst on screen.
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dst.tex);
    gl.uniform1i(this.blitU.uTex, 0);
    gl.uniform2f(this.blitU.uRes, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.index = 1 - this.index;
  }
}
