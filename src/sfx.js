// ─────────────────────────────────────────────
// Sound effects using pre-decoded MP3 AudioBuffers
// Each play() creates a lightweight BufferSourceNode
// that overlaps naturally and auto-garbage-collects.
// ─────────────────────────────────────────────

// Sound file manifest — grouped by category
const SOUNDS = {
  // Attack swing whoosh (plays on startup)
  whoosh:     ['/assets/dash.mp3', '/assets/dash_2.mp3'],
  // Impact sounds (play on hit only)
  hit:        ['/assets/slap.mp3', '/assets/slap_2.mp3', '/assets/punch.mp3', '/assets/punch_2.mp3', '/assets/punch_3.mp3', '/assets/punch_4.mp3'],
  block:      ['/assets/punch_3.mp3', '/assets/punch_4.mp3'],
  headshot:   ['/assets/headshot.mp3', '/assets/headshot_2.mp3'],
  crotchshot: ['/assets/crotchshot.mp3', '/assets/crotchshot_2.mp3'],
  clash:      ['/assets/punch_4.mp3', '/assets/punch_3.mp3'],
  somersault: ['/assets/somersault.mp3'],
  dash:       ['/assets/dash.mp3', '/assets/dash_2.mp3'],
  hadouken_charge: ['/assets/somersault.mp3'],
  hadouken_fire:   ['/assets/dash.mp3', '/assets/dash_2.mp3'],
};

export class SFX {
  constructor() {
    this._audioCtx = null;
    this._buffers = {};  // path → AudioBuffer
    this._loaded = false;
  }

  /** Lazy-init AudioContext (must happen after user gesture) */
  _ctx() {
    if (!this._audioCtx) {
      this._audioCtx = new AudioContext();
    }
    if (this._audioCtx.state === 'suspended') {
      this._audioCtx.resume();
    }
    return this._audioCtx;
  }

  /** Preload all MP3s into decoded AudioBuffers */
  async preload() {
    if (this._loaded) return;
    const ctx = this._ctx();

    // Collect unique paths
    const paths = new Set();
    for (const files of Object.values(SOUNDS)) {
      for (const path of files) paths.add(path);
    }

    // Fetch + decode in parallel
    const entries = await Promise.all(
      [...paths].map(async (path) => {
        try {
          const resp = await fetch(path);
          const arrayBuf = await resp.arrayBuffer();
          const audioBuf = await ctx.decodeAudioData(arrayBuf);
          return [path, audioBuf];
        } catch (e) {
          console.warn(`SFX: failed to load ${path}`, e);
          return [path, null];
        }
      })
    );

    for (const [path, buf] of entries) {
      if (buf) this._buffers[path] = buf;
    }

    this._loaded = true;
  }

  /** Play a random variant from a category at given volume */
  _play(category, volume = 0.5) {
    const files = SOUNDS[category];
    if (!files || files.length === 0) return;

    const ctx = this._ctx();
    const path = files[Math.floor(Math.random() * files.length)];
    const buffer = this._buffers[path];
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.connect(ctx.destination);

    source.connect(gain);
    source.start(0);
  }

  // ── Public sound methods ─────────────────────

  whoosh()     { this._play('whoosh', 0.3); }
  hit()        { this._play('hit', 0.5); }
  block()      { this._play('block', 0.3); }
  headshot()   { this._play('headshot', 0.7); }
  crotchshot() { this._play('crotchshot', 0.7); }
  clash()      { this._play('clash', 0.6); }
  somersault()     { this._play('somersault', 0.5); }
  dash()           { this._play('dash', 0.4); }
  hadoukenCharge() { this._play('hadouken_charge', 0.4); }
  hadoukenFire()   { this._play('hadouken_fire', 0.5); }
}
