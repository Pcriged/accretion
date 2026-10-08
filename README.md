# Accretion

Music visualizers built around a black hole, running in the browser with WebGL 2. No build step and no dependencies.

## Versions

### `Realistic/`: Accretion

A physically based black hole that feeds on your music.

- **Gravitational lensing**: every pixel traces a light ray through Schwarzschild spacetime, giving the Einstein ring, the photon ring, and the far side of the disc arching over the shadow.
- **Accretion disc**: blackbody colour with a Novikov–Thorne temperature profile, relativistic Doppler beaming and gravitational redshift, rendered in HDR with bloom and ACES tone mapping.
- **Music as fuel**: the live spectrum is injected as a stream of gas (bass on the inside edge, treble outside) that spirals in and is sheared into the disc. Stream width follows loudness, colour follows the detected chord root, and beats cause flares.
- **Speaker pump**: gravity, and with it the lensing, thumps outward on every kick.

Drag to orbit, scroll to zoom. Keys: Space play/pause, H hide panel, F fullscreen.

### Root folder: Event Horizon

The original, stylised and psychedelic version.

## Running

Serve the folder over HTTP, then open `http://localhost:8765/` (original) or `http://localhost:8765/Realistic/`:

```bash
python -m http.server 8765
```

Audio sources: a local file, the microphone, system audio (Chrome or Edge: tick "Share system audio"), or the built-in demo groove.
