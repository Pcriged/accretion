/* renderer.js: physically based black hole, WebGL2.
   Pass 1  sim     : the gas in the disc plane, stored in polar coordinates (azimuth x log radius).
                     Each frame it is advected by Keplerian rotation and inward drift, and the
                     music is injected as a stream of matter whose cross-section is the spectrum.
   Pass 2  ray     : every pixel traces a light ray through Schwarzschild spacetime. Where the ray
                     crosses the disc plane it picks up blackbody emission (Doppler beamed and
                     gravitationally redshifted). Rays that escape see a lensed starfield.
   Pass 3  bloom   : dual-filter downsample / upsample chain on the HDR image.
   Pass 4  output  : exposure, ACES filmic tone map, vignette, dither.
   Units: G = c = M = 1, so the horizon is at r = 2 and the ISCO at r = 6. */

const FULL_VERT = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
out vec4 fragColor;
const float PI = 3.14159265359;
const float TAU = 6.28318530718;
const float R_MIN = 2.0;     // inner edge of the gas grid (the horizon)
const float R_MAX = 28.0;    // outer edge of the gas grid
const float R_ISCO = 6.0;    // innermost stable circular orbit
float rToV(float r) { return log(r / R_MIN) / log(R_MAX / R_MIN); }
float vToR(float v) { return R_MIN * pow(R_MAX / R_MIN, v); }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

/* ---------- pass 1: gas simulation ---------- */

const SIM_FRAG = HEADER + `
uniform sampler2D uPrev;     // r = surface density, g = heat (temperature excess)
uniform sampler2D uSpec;     // 256 log-spaced spectrum bins
uniform vec2  uSize;
uniform float uDt;           // simulated time this frame, in M
uniform float uFeed;         // how much matter the music pours in
uniform float uBase;         // ambient turbulence that keeps the disc alive in silence
uniform float uLevel, uTreble, uBeat;
uniform float uSeed;
uniform float uInjPhi;       // azimuth where the stream enters
uniform float uWidth;        // stream width multiplier, follows loudness
uniform vec2  uHue;          // colour of the music right now: hue as a direction, saturation as length

const float R_DISK = 13.0;   // outer edge of the settled disc
const float R_INJ = 21.0;    // where the stream is injected
const float W_INJ = 1.3;     // half width of the stream (radial)

// Value noise that tiles every 'per' cells along x, because the azimuth wraps.
float tnoise(vec2 p, float per, float seed) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, per);
  float x1 = mod(i.x + 1.0, per);
  float a = hash12(vec2(x0, i.y) + seed);
  float b = hash12(vec2(x1, i.y) + seed);
  float c = hash12(vec2(x0, i.y + 1.0) + seed);
  float d = hash12(vec2(x1, i.y + 1.0) + seed);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float omega(float r) { return pow(r, -1.5); }   // Keplerian angular velocity

// Inward drift: slow viscous drift in the disc, fast free fall in the stream,
// and a plunge inside the ISCO where no stable orbit exists.
float radialVel(float r) {
  float v = mix(-0.008, -0.045, smoothstep(R_DISK - 1.0, R_DISK + 3.0, r));
  return mix(-0.12, v, smoothstep(R_ISCO - 1.5, R_ISCO, r));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float r = vToR(uv.y);
  float phi = uv.x * TAU;

  // Semi-Lagrangian advection: take whatever was upstream one step ago.
  float rUp = r - radialVel(r) * uDt;
  float phiUp = phi - omega(r) * uDt;
  float vUp = rToV(rUp);
  vec4 prev = vUp > 1.0 ? vec4(0.0) : texture(uPrev, vec2(phiUp / TAU, vUp));

  float inside = 1.0 - smoothstep(R_ISCO - 2.5, R_ISCO, r);
  float dens = prev.r * exp(-uDt * (0.0016 + 0.02 * inside));
  // Hot spots cool quickly in the disc; the infalling stream stays shock-heated.
  float streamZone = smoothstep(R_DISK - 1.0, R_DISK + 3.0, r);
  float heat = prev.g * exp(-uDt * mix(0.03, 0.006, streamZone));
  // Colour is carried as density x hue vector, so mixed gas averages its colours.
  // Once the gas settles into the disc it slowly thermalises back to blackbody.
  vec2 hue = prev.ba * exp(-uDt * (0.0016 + 0.02 * inside + 0.0005 * (1.0 - streamZone)));

  float disc = smoothstep(R_ISCO - 0.5, R_ISCO + 1.5, r)
             * (1.0 - smoothstep(R_DISK - 3.0, R_DISK + 1.0, r));

  // Ambient turbulence: random clumps, sheared into filaments by the rotation.
  // Only the rare peaks inject, so each clump is a distinct event that leaves its own filament.
  float clump = tnoise(vec2(uv.x * 48.0, uv.y * 40.0), 48.0, uSeed);
  // clump^28 by squaring: pow() is undefined at 0 and can give NaN on some GPUs.
  float c4 = clump * clump; c4 *= c4;
  float c8 = c4 * c4;
  dens += uDt * 0.5 * uBase * disc * c8 * c8 * c8 * c4;

  // Beats: flares erupt in the inner disc.
  float flare = tnoise(vec2(uv.x * 20.0, uv.y * 16.0), 20.0, uSeed + 37.0);
  float inner = disc * (1.0 - smoothstep(R_ISCO + 1.0, R_DISK, r) * 0.6);
  heat += uDt * inner * flare * flare * flare * (0.6 * uBeat + 0.05 * uTreble);

  // The music stream: across its width it carries the spectrum (bass on the
  // inside edge, treble outside), along its length it carries time. It is the
  // spectrogram of the song, falling into the hole.
  float w = W_INJ * uWidth;
  float s = (r - (R_INJ - w)) / (2.0 * w);
  float across = smoothstep(0.0, 0.08, s) * (1.0 - smoothstep(0.92, 1.0, s));
  float dphi = atan(sin(phi - uInjPhi), cos(phi - uInjPhi));
  float along = exp(-dphi * dphi / (2.0 * 0.014 * 0.014));
  float bin = texture(uSpec, vec2(mix(0.03, 0.85, s), 0.5)).r;
  float inj = along * across;
  float added = uDt * 1.2 * uFeed * inj * (0.04 + 2.2 * bin * sqrt(bin) + 0.3 * uLevel);
  dens += added;
  hue += added * uHue;
  heat += uDt * 1.2 * inj * (0.6 * uTreble + 1.5 * uBeat + 0.8 * bin);

  // A NaN here would be advected across the whole disc, so never let one through.
  if (!(dens >= 0.0 && dens < 1e6)) { dens = 0.0; hue = vec2(0.0); }
  if (!(heat >= 0.0 && heat < 1e6)) heat = 0.0;
  float cap = min(1.0, 6.0 / max(dens, 1e-6));
  fragColor = vec4(dens * cap, min(heat, 3.0), hue * cap);
}`;

/* ---------- pass 2: ray tracing through curved spacetime ---------- */

const RAY_FRAG = HEADER + `
uniform vec2  uRes;
uniform vec3  uCamPos, uCamRight, uCamUp, uCamFwd;
uniform float uTanHalf;
uniform float uPixAngle;     // angular size of one pixel, for star filtering
uniform sampler2D uDisc;
uniform float uGravity;      // 1 = general relativity, 0 = no bending
uniform float uDoppler;      // 0 = colour as emitted, 1 = full beaming and redshift
uniform float uTemp;         // peak disc temperature, Kelvin
uniform float uTint;         // how strongly the music's colour shows over the blackbody

const int MAX_STEPS = 320;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x),
                 mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x),
                 mix(hash13(i + vec3(0, 1, 1)), hash13(i + 1.0), f.x), f.y), f.z);
}

float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise3(p);
    p = p * 2.03 + 1.7;
    a *= 0.5;
  }
  return v;
}

// Blackbody colour (linear RGB, brightest channel about 1) for a temperature in Kelvin.
vec3 blackbody(float t) {
  t = clamp(t, 1000.0, 40000.0) / 100.0;
  vec3 c;
  c.r = t <= 66.0 ? 1.0 : 1.292936 * pow(t - 60.0, -0.1332047592);
  c.g = t <= 66.0 ? 0.39008157 * log(t) - 0.63184144 : 1.129890861 * pow(t - 60.0, -0.0755148492);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : 0.54320678 * log(t - 10.0) - 1.19625408);
  return pow(clamp(c, 1e-6, 1.0), vec3(2.2));
}

vec3 starLayer(vec3 d, float scale, float prob, float gain) {
  vec3 c = floor(d * scale);
  vec3 h = hash33(c);
  if (h.x > prob) return vec3(0.0);
  vec3 sp = normalize(c + 0.3 + 0.4 * hash33(c + 11.7));
  vec3 dd = sp - d;
  float w = uPixAngle * 0.9;
  float b = exp(-dot(dd, dd) / (w * w));
  vec3 tint = blackbody(mix(2800.0, 16000.0, h.z * h.z));
  tint /= max(tint.r, max(tint.g, tint.b));
  return tint * b * gain * (0.02 + 4.0 * pow(max(h.y, 1e-6), 12.0));
}

// The sky behind the hole: a faint galactic band and three layers of stars.
vec3 background(vec3 d) {
  vec3 n = normalize(vec3(0.35, 1.0, -0.25));
  float lat = dot(d, n);
  float band = exp(-lat * lat * 9.0);
  float neb = fbm3(d * 3.5);
  float dust = smoothstep(0.45, 0.7, fbm3(d * 7.0 + 4.0));
  vec3 col = band * (0.004 + 0.035 * neb * neb) * (1.0 - 0.75 * dust) * vec3(0.85, 0.82, 1.0);
  col += starLayer(d, 50.0, 0.06 + 0.10 * band, 1.0);
  col += starLayer(d, 110.0, 0.04 + 0.10 * band, 0.6);
  col += starLayer(d, 240.0, 0.03 + 0.12 * band, 0.4);
  return col;
}

// Emission of the disc at a plane crossing. Returns rgb, alpha in .a
vec4 discSample(vec3 hit, vec3 dir) {
  float r = length(hit.xz);
  vec4 g4 = textureLod(uDisc, vec2(atan(hit.z, hit.x) / TAU, rToV(r)), 0.0);
  float dens = g4.r;
  if (dens < 1e-4) return vec4(0.0);

  // Thin disc seen at a grazing angle: longer path, more optical depth.
  // Fine ring striations: density waves that are steady in r, so rotation does not change them.
  float lr = log(r);
  dens *= 0.55 + 0.9 * fbm3(vec3(lr * 38.0, lr * 9.0, 3.1)) ;

  float mu = max(abs(dir.y) / length(dir), 0.2);
  float alpha = 1.0 - exp(-dens * 0.7 / mu);

  // Novikov-Thorne temperature profile, normalised so its peak is uTemp.
  float f = max(1.0 - sqrt(R_ISCO / r), 0.0) + 0.002;
  float T = uTemp * pow(r / R_ISCO, -0.75) * pow(f, 0.25) / 0.486;
  T *= 1.0 + 0.5 * g4.g;                                    // music-driven flares

  // Gas orbits prograde (counter-clockwise seen from +y).
  vec3 vhat = normalize(vec3(-hit.z, 0.0, hit.x));
  float beta = min(inversesqrt(max(r - 2.0, 1e-3)), 0.7);   // orbital speed, static frame
  float gamma = inversesqrt(1.0 - beta * beta);
  vec3 toCam = -normalize(dir);                             // photon travels back along the ray
  float dop = 1.0 / (gamma * (1.0 - beta * dot(vhat, toCam)));
  float grav = sqrt(max(1.0 - 2.0 / r, 0.0));
  float g = mix(1.0, dop * grav, uDoppler);

  float Tobs = g * T;
  float tr = Tobs / uTemp;
  float I = tr * tr * tr * tr;                         // Stefan-Boltzmann
  vec3 col = blackbody(Tobs);

  // Music colour carried by the gas. Hue from the stored vector, saturation from
  // how pure it still is. Matched to the blackbody's luminance so brightness stays physical.
  vec2 hv = g4.ba / dens;
  float sat = clamp(pow(max(length(hv) * 2.5, 1e-6), 0.6), 0.0, 1.0) * uTint;
  if (sat > 0.001) {
    float h = atan(hv.y, hv.x) / TAU;
    vec3 tint = pow(clamp(abs(fract(h + vec3(0.0, 2.0, 1.0) / 3.0) * 6.0 - 3.0) - 1.0, 1e-6, 1.0), vec3(2.2));
    const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
    tint *= dot(col, LUM) / max(dot(tint, LUM), 0.02);
    col = mix(col, tint, sat);
  }
  return vec4(col * I * alpha, alpha);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / (0.5 * min(uRes.x, uRes.y));
  vec3 vel = normalize(uCamFwd + uTanHalf * (p.x * uCamRight + p.y * uCamUp));
  vec3 pos = uCamPos;

  // Null geodesics in Schwarzschild: x'' = -1.5 h^2 x / r^5, with h = |x cross v| conserved.
  vec3 L = cross(pos, vel);
  float k = 1.5 * dot(L, L) * uGravity;

  vec3 col = vec3(0.0);
  float trans = 1.0;
  bool escaped = false;

  for (int i = 0; i < MAX_STEPS; i++) {
    float r = length(pos);
    float h = clamp(0.06 * r, 0.03, 2.0);

    // Velocity Verlet step.
    vec3 a = -k * pos / pow(r, 5.0);
    vec3 np = pos + vel * h + 0.5 * a * h * h;
    float nr = length(np);
    vec3 na = -k * np / pow(nr, 5.0);
    vec3 nv = vel + 0.5 * (a + na) * h;

    // Crossed the disc plane: add the gas there, then keep going. This is what
    // produces the far side arching over the hole and the higher-order images.
    if (pos.y * np.y < 0.0) {
      float t = pos.y / (pos.y - np.y);
      vec3 hit = mix(pos, np, t);
      float hr = length(hit.xz);
      if (hr > R_MIN && hr < R_MAX) {
        vec4 e = discSample(hit, mix(vel, nv, t));
        col += trans * e.rgb;
        trans *= 1.0 - e.a;
      }
    }

    pos = np;
    vel = nv;
    if (nr < 2.0) break;                                    // fell through the horizon
    if (nr > 80.0 && dot(pos, vel) > 0.0) { escaped = true; break; }
    if (trans < 0.003) break;
  }

  if (escaped) col += trans * background(normalize(vel));
  fragColor = vec4(col, 1.0);
}`;

/* ---------- pass 3: bloom ---------- */

const DOWN_FRAG = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;       // 1 / source size
uniform vec2 uDstSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstSize;
  vec3 s = texture(uSrc, uv).rgb * 4.0;
  s += texture(uSrc, uv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(uSrc, uv + uTexel * vec2( 1.0, -1.0)).rgb;
  s += texture(uSrc, uv + uTexel * vec2(-1.0,  1.0)).rgb;
  s += texture(uSrc, uv + uTexel * vec2( 1.0,  1.0)).rgb;
  fragColor = vec4(min(s / 8.0, vec3(64.0)), 1.0);
}`;

const UP_FRAG = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uTexel;       // 1 / source size
uniform vec2 uDstSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uDstSize;
  vec2 o = uTexel;
  vec3 s = texture(uSrc, uv + vec2(-2.0 * o.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(2.0 * o.x, 0.0)).rgb;
  s += texture(uSrc, uv + vec2(0.0, -2.0 * o.y)).rgb;
  s += texture(uSrc, uv + vec2(0.0, 2.0 * o.y)).rgb;
  s += texture(uSrc, uv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(o.x, o.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(-o.x, -o.y)).rgb * 2.0;
  s += texture(uSrc, uv + vec2(o.x, -o.y)).rgb * 2.0;
  fragColor = vec4(s / 12.0, 1.0);
}`;

/* ---------- pass 4: tone map to screen ---------- */

const OUT_FRAG = HEADER + `
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform vec2  uRes;
uniform float uExposure, uBloomAmt, uBloomNorm, uTime;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = texture(uHdr, uv).rgb;
  vec3 b = texture(uBloom, uv).rgb * uBloomNorm;
  c = mix(c, b, uBloomAmt * 0.35) + b * uBloomAmt * 0.25;
  c *= uExposure;
  vec2 q = uv - 0.5;
  c *= 1.0 - 0.35 * dot(q, q) * 2.0;
  c = aces(c);
  c = pow(max(c, vec3(1e-6)), vec3(1.0 / 2.2));
  c += (hash12(gl_FragCoord.xy + fract(uTime) * 517.0) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}`;

class Renderer {
  static SIM_W = 1024;
  static SIM_H = 512;
  static BLOOM_LEVELS = 6;

  constructor(canvas) {
    const gl = canvas.getContext("webgl2", { antialias: false, alpha: false });
    if (!gl) throw new Error("WebGL 2 is not available in this browser.");
    this.canvas = canvas;
    this.gl = gl;

    // HDR needs float render targets. Without them we fall back to 8-bit (clipped highlights).
    const floatRT = !!gl.getExtension("EXT_color_buffer_float");
    const floatLinear = !!gl.getExtension("OES_texture_float_linear");
    this.hdrFmt = floatRT
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    // The gas decays very slowly per frame, so it wants full float precision.
    this.simFmt = floatRT && floatLinear
      ? { internal: gl.RGBA32F, type: gl.FLOAT }
      : this.hdrFmt;
    this.hdrSupported = floatRT;

    this.simProg = this.program(SIM_FRAG);
    this.rayProg = this.program(RAY_FRAG);
    this.downProg = this.program(DOWN_FRAG);
    this.upProg = this.program(UP_FRAG);
    this.outProg = this.program(OUT_FRAG);
    this.simU = this.uniforms(this.simProg, ["uPrev", "uSpec", "uSize", "uDt", "uFeed", "uBase",
      "uLevel", "uTreble", "uBeat", "uSeed", "uInjPhi", "uHue", "uWidth"]);
    this.rayU = this.uniforms(this.rayProg, ["uRes", "uCamPos", "uCamRight", "uCamUp", "uCamFwd",
      "uTanHalf", "uPixAngle", "uDisc", "uGravity", "uDoppler", "uTemp", "uTint"]);
    this.downU = this.uniforms(this.downProg, ["uSrc", "uTexel", "uDstSize"]);
    this.upU = this.uniforms(this.upProg, ["uSrc", "uTexel", "uDstSize"]);
    this.outU = this.uniforms(this.outProg, ["uHdr", "uBloom", "uRes", "uExposure", "uBloomAmt",
      "uBloomNorm", "uTime"]);

    // One big triangle covers clip space.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 256x1 spectrum, one byte per bin.
    this.spectrumTex = this.texture(gl.R8, gl.RED, gl.UNSIGNED_BYTE, 256, 1, null, false);

    // Gas grid, ping-ponged. Azimuth wraps.
    const W = Renderer.SIM_W, H = Renderer.SIM_H;
    this.sim = [this.target(W, H, this.simFmt, true), this.target(W, H, this.simFmt, true)];
    this.simIndex = 0;

    this.hdr = null;
    this.bloom = [];
    this.quality = 0.7;
    this.silence = new Uint8Array(256);
  }

  /* ---------- GL helpers ---------- */

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

  program(fsSrc) {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this.compile(gl.VERTEX_SHADER, FULL_VERT));
    gl.attachShader(prog, this.compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog));
    }
    return prog;
  }

  uniforms(prog, names) {
    const loc = {};
    for (const name of names) loc[name] = this.gl.getUniformLocation(prog, name);
    return loc;
  }

  texture(internal, format, type, w, h, data, repeatX) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, repeatX ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return tex;
  }

  target(w, h, fmt, repeatX) {
    const gl = this.gl;
    const tex = this.texture(fmt.internal, gl.RGBA, fmt.type, w, h, null, repeatX);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fb, w, h };
  }

  freeTarget(t) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  }

  bindTex(unit, tex) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  draw(t) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    if (t) gl.viewport(0, 0, t.w, t.h);
    else gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ---------- sizing ---------- */

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    const rw = Math.max(2, Math.round(w * this.quality));
    const rh = Math.max(2, Math.round(h * this.quality));
    if (w === this.canvas.width && h === this.canvas.height && this.hdr
        && this.hdr.w === rw && this.hdr.h === rh) return;

    this.canvas.width = w;
    this.canvas.height = h;
    this.freeTarget(this.hdr);
    this.bloom.forEach((t) => this.freeTarget(t));

    this.hdr = this.target(rw, rh, this.hdrFmt, false);
    this.bloom = [];
    let bw = rw, bh = rh;
    for (let i = 0; i < Renderer.BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1);
      bh = Math.max(1, bh >> 1);
      this.bloom.push(this.target(bw, bh, this.hdrFmt, false));
      if (bw <= 4 || bh <= 4) break;
    }
  }

  /* ---------- passes ---------- */

  stepSim(s, dtM) {
    const gl = this.gl;
    const src = this.sim[this.simIndex];
    const dst = this.sim[1 - this.simIndex];
    gl.useProgram(this.simProg);
    this.bindTex(0, src.tex);
    this.bindTex(1, this.spectrumTex);
    const u = this.simU;
    gl.uniform1i(u.uPrev, 0);
    gl.uniform1i(u.uSpec, 1);
    gl.uniform2f(u.uSize, dst.w, dst.h);
    gl.uniform1f(u.uDt, dtM);
    gl.uniform1f(u.uFeed, s.feed);
    gl.uniform1f(u.uBase, s.base);
    gl.uniform1f(u.uLevel, s.level);
    gl.uniform1f(u.uTreble, s.treble);
    gl.uniform1f(u.uBeat, s.beat);
    gl.uniform1f(u.uSeed, Math.floor(Math.random() * 997));
    gl.uniform1f(u.uInjPhi, s.injPhi);
    gl.uniform2f(u.uHue, s.hue[0], s.hue[1]);
    gl.uniform1f(u.uWidth, s.width);
    this.draw(dst);
    this.simIndex = 1 - this.simIndex;
  }

  // Run the gas for a while so the disc is already formed on the first frame.
  warmUp(base) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    this.bindTex(1, this.spectrumTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, this.silence);
    const quiet = { feed: 1, base, level: 0, treble: 0, beat: 0, injPhi: 0, hue: [0, 0], width: 1 };
    for (let i = 0; i < 400; i++) this.stepSim(quiet, 6);
  }

  render(s) {
    const gl = this.gl;
    this.quality = s.quality;
    this.resize();
    gl.bindVertexArray(this.vao);

    // 1) gas
    this.bindTex(1, this.spectrumTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RED, gl.UNSIGNED_BYTE, s.spectrum);
    this.stepSim(s, s.dtM);

    // 2) rays
    const hdr = this.hdr;
    const c = s.camera;
    gl.useProgram(this.rayProg);
    this.bindTex(0, this.sim[this.simIndex].tex);
    const u = this.rayU;
    gl.uniform1i(u.uDisc, 0);
    gl.uniform2f(u.uRes, hdr.w, hdr.h);
    gl.uniform3fv(u.uCamPos, c.pos);
    gl.uniform3fv(u.uCamRight, c.right);
    gl.uniform3fv(u.uCamUp, c.up);
    gl.uniform3fv(u.uCamFwd, c.fwd);
    gl.uniform1f(u.uTanHalf, c.tanHalf);
    gl.uniform1f(u.uPixAngle, (2 * c.tanHalf) / Math.min(hdr.w, hdr.h));
    gl.uniform1f(u.uGravity, s.gravity);
    gl.uniform1f(u.uDoppler, s.doppler);
    gl.uniform1f(u.uTemp, s.temp);
    gl.uniform1f(u.uTint, s.tint);
    this.draw(hdr);

    // 3) bloom: down the chain, then back up, adding each level into the one above
    gl.useProgram(this.downProg);
    gl.uniform1i(this.downU.uSrc, 0);
    let src = hdr;
    for (const dst of this.bloom) {
      this.bindTex(0, src.tex);
      gl.uniform2f(this.downU.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform2f(this.downU.uDstSize, dst.w, dst.h);
      this.draw(dst);
      src = dst;
    }
    gl.useProgram(this.upProg);
    gl.uniform1i(this.upU.uSrc, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.bloom.length - 1; i > 0; i--) {
      const from = this.bloom[i];
      const to = this.bloom[i - 1];
      this.bindTex(0, from.tex);
      gl.uniform2f(this.upU.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform2f(this.upU.uDstSize, to.w, to.h);
      this.draw(to);
    }
    gl.disable(gl.BLEND);

    // 4) screen
    gl.useProgram(this.outProg);
    this.bindTex(0, hdr.tex);
    this.bindTex(1, this.bloom[0].tex);
    const o = this.outU;
    gl.uniform1i(o.uHdr, 0);
    gl.uniform1i(o.uBloom, 1);
    gl.uniform2f(o.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(o.uExposure, s.exposure);
    gl.uniform1f(o.uBloomAmt, s.bloom);
    gl.uniform1f(o.uBloomNorm, 1 / this.bloom.length);
    gl.uniform1f(o.uTime, s.time);
    this.draw(null);
  }
}
