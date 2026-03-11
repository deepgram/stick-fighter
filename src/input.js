// ─────────────────────────────────────────────
// Abstract Input System
// ─────────────────────────────────────────────
// Game logic only sees "actions" — never raw keys/buttons.
// Each InputAdapter translates device signals into actions.
// Compound actions (dash, somersault) are emitted by adapters,
// not detected by game logic.

export const Actions = Object.freeze({
  // Directional (held)
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',

  // Attacks (edge-triggered)
  LIGHT_PUNCH: 'lightPunch',
  MEDIUM_PUNCH: 'mediumPunch',
  HEAVY_PUNCH: 'heavyPunch',
  LIGHT_KICK: 'lightKick',
  MEDIUM_KICK: 'mediumKick',
  HEAVY_KICK: 'heavyKick',

  // Compound actions (edge-triggered)
  JUMP: 'jump',
  SOMERSAULT: 'somersault',
  DASH_FORWARD: 'dashForward',   // semantic: toward opponent (voice/LLM)
  DASH_BACK: 'dashBack',         // semantic: away from opponent (voice/LLM)
  DASH_LEFT: 'dashLeft',         // directional: always left (keyboard)
  DASH_RIGHT: 'dashRight',       // directional: always right (keyboard)
});

// ─────────────────────────────────────────────
// InputManager — holds adapters, merges their state
// ─────────────────────────────────────────────
export class InputManager {
  constructor() {
    this.adapters = [];
  }

  addAdapter(adapter) {
    this.adapters.push(adapter);
    adapter.attach();
    return this;
  }

  removeAdapter(adapter) {
    adapter.detach();
    this.adapters = this.adapters.filter(a => a !== adapter);
    return this;
  }

  /** Returns a Set of currently active actions (held state) */
  getActions() {
    const actions = new Set();
    for (const adapter of this.adapters) {
      for (const action of adapter.getActions()) {
        actions.add(action);
      }
    }
    return actions;
  }

  /** Returns actions that just started this frame (edge-triggered) */
  getJustPressed() {
    const pressed = new Set();
    for (const adapter of this.adapters) {
      if (adapter.getJustPressed) {
        for (const action of adapter.getJustPressed()) {
          pressed.add(action);
        }
      }
    }
    return pressed;
  }

  /** Tick timed adapters (call with dt each frame, before getActions/getJustPressed) */
  update(dt) {
    for (const adapter of this.adapters) {
      if (adapter.update) adapter.update(dt);
    }
  }

  /** Call at end of each frame to reset edge-triggered state */
  endFrame() {
    for (const adapter of this.adapters) {
      if (adapter.endFrame) adapter.endFrame();
    }
  }
}

// ─────────────────────────────────────────────
// Command vocabulary — maps words to action(s) + timing
// ─────────────────────────────────────────────
// 'hold' actions are sustained for `duration` seconds
// 'press' actions fire once (edge-triggered)
const COMMAND_VOCAB = {
  // Movement (held for duration)
  'forward':    { hold: [Actions.RIGHT],  duration: 1.0, semantic: true },
  'forwards':   { hold: [Actions.RIGHT],  duration: 1.0, semantic: true },
  'back':       { hold: [Actions.LEFT],   duration: 1.0, semantic: true },
  'backward':   { hold: [Actions.LEFT],   duration: 1.0, semantic: true },
  'backwards':  { hold: [Actions.LEFT],   duration: 1.0, semantic: true },
  'crouch':     { hold: [Actions.DOWN],   duration: 1.0 },
  'duck':       { hold: [Actions.DOWN],   duration: 1.0 },

  // Jumps (edge-triggered)
  'jump':       { press: [Actions.JUMP] },
  'somersault': { press: [Actions.SOMERSAULT, Actions.JUMP] },
  'flip':       { press: [Actions.SOMERSAULT, Actions.JUMP] },

  // Dashes (edge-triggered, semantic)
  'dash':           { press: [Actions.DASH_FORWARD] },
  'dash forward':   { press: [Actions.DASH_FORWARD] },
  'dash forwards':  { press: [Actions.DASH_FORWARD] },
  'dash back':      { press: [Actions.DASH_BACK] },
  'dash backward':  { press: [Actions.DASH_BACK] },
  'dash backwards': { press: [Actions.DASH_BACK] },

  // Attacks (edge-triggered)
  'punch':        { press: [Actions.LIGHT_PUNCH] },
  'light punch':  { press: [Actions.LIGHT_PUNCH] },
  'jab':          { press: [Actions.LIGHT_PUNCH] },
  'medium punch': { press: [Actions.MEDIUM_PUNCH] },
  'strong':       { press: [Actions.MEDIUM_PUNCH] },
  'hard punch':   { press: [Actions.HEAVY_PUNCH] },
  'heavy punch':  { press: [Actions.HEAVY_PUNCH] },
  'fierce':       { press: [Actions.HEAVY_PUNCH] },
  'kick':         { press: [Actions.LIGHT_KICK] },
  'light kick':   { press: [Actions.LIGHT_KICK] },
  'short':        { press: [Actions.LIGHT_KICK] },
  'medium kick':  { press: [Actions.MEDIUM_KICK] },
  'heavy kick':   { press: [Actions.HEAVY_KICK] },
  'roundhouse':   { press: [Actions.HEAVY_KICK] },
};

export { COMMAND_VOCAB };

// ─────────────────────────────────────────────
// CommandAdapter — converts text commands into
// timed actions. Used by voice and LLM adapters.
// ─────────────────────────────────────────────
export class CommandAdapter {
  constructor(facing = 1) {
    this.facing = facing; // 1 = right, -1 = left. Updated by game each frame.
    this.held = new Set();
    this.justPressed = new Set();
    // Active timed holds: [{ actions: [...], remaining: seconds }]
    this._timedHolds = [];
  }

  attach() {}
  detach() {}

  /** Update facing direction (call from game loop) */
  setFacing(facing) {
    this.facing = facing;
  }

  /**
   * Execute a text command string, e.g. "forward somersault" or "hard punch"
   * Parses into individual tokens, matches against COMMAND_VOCAB,
   * and queues the resulting actions.
   */
  execute(text) {
    const normalized = text.toLowerCase().trim();

    // Try matching multi-word commands first (longest match wins)
    const matched = new Set();
    let remaining = normalized;

    // Sort vocab keys by length descending for greedy matching
    const sortedKeys = Object.keys(COMMAND_VOCAB).sort((a, b) => b.length - a.length);

    while (remaining.length > 0) {
      let found = false;
      for (const key of sortedKeys) {
        if (remaining.startsWith(key)) {
          const cmd = COMMAND_VOCAB[key];
          this._applyCommand(cmd);
          remaining = remaining.slice(key.length).trim();
          found = true;
          break;
        }
      }
      if (!found) {
        // Skip unrecognized word
        const spaceIdx = remaining.indexOf(' ');
        if (spaceIdx === -1) break;
        remaining = remaining.slice(spaceIdx + 1).trim();
      }
    }
  }

  _applyCommand(cmd) {
    // Edge-triggered actions
    if (cmd.press) {
      for (const action of cmd.press) {
        this.justPressed.add(action);
      }
    }

    // Timed hold actions
    if (cmd.hold && cmd.duration) {
      let actions = [...cmd.hold];

      // Semantic direction: flip LEFT/RIGHT based on facing
      if (cmd.semantic) {
        actions = actions.map(a => {
          if (a === Actions.RIGHT) return this.facing === 1 ? Actions.RIGHT : Actions.LEFT;
          if (a === Actions.LEFT) return this.facing === 1 ? Actions.LEFT : Actions.RIGHT;
          return a;
        });
      }

      this._timedHolds.push({ actions, remaining: cmd.duration });
      // Also add to held immediately
      for (const action of actions) {
        this.held.add(action);
      }
    }
  }

  /** Call each frame with dt to tick down timed holds */
  update(dt) {
    // Rebuild held set from active timed holds
    this.held.clear();
    this._timedHolds = this._timedHolds.filter(hold => {
      hold.remaining -= dt;
      if (hold.remaining > 0) {
        for (const action of hold.actions) {
          this.held.add(action);
        }
        return true;
      }
      return false;
    });
  }

  getActions() {
    return this.held;
  }

  getJustPressed() {
    return this.justPressed;
  }

  endFrame() {
    this.justPressed.clear();
  }
}

// ─────────────────────────────────────────────
// Double-tap detection window (seconds)
// ─────────────────────────────────────────────
const DOUBLE_TAP_WINDOW = 0.25;

// ─────────────────────────────────────────────
// KeyboardAdapter — maps keys → actions,
// detects double-taps → compound actions
// ─────────────────────────────────────────────
export class KeyboardAdapter {
  constructor(keyMap) {
    this.keyMap = keyMap; // { 'KeyW': Actions.UP, ... }
    this.held = new Set();
    this.justPressed = new Set();

    // Double-tap tracking: action → last press timestamp
    this._lastTap = {};

    this._onDown = this._onDown.bind(this);
    this._onUp = this._onUp.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
  }

  detach() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
  }

  _onDown(e) {
    const action = this.keyMap[e.code];
    if (!action) return;
    e.preventDefault();

    if (!this.held.has(action)) {
      const now = performance.now() / 1000;
      const lastTap = this._lastTap[action] || 0;

      // Detect double-taps and emit compound actions
      if (now - lastTap < DOUBLE_TAP_WINDOW) {
        if (action === Actions.UP) {
          this.justPressed.add(Actions.SOMERSAULT);
        } else if (action === Actions.LEFT) {
          this.justPressed.add(Actions.DASH_LEFT);
        } else if (action === Actions.RIGHT) {
          this.justPressed.add(Actions.DASH_RIGHT);
        }
        this._lastTap[action] = 0; // reset so triple-tap doesn't re-trigger
      } else {
        // First tap — emit the base action + JUMP for UP
        if (action === Actions.UP) {
          this.justPressed.add(Actions.JUMP);
        }
        this._lastTap[action] = now;
      }

      this.justPressed.add(action);
    }
    this.held.add(action);
  }

  _onUp(e) {
    const action = this.keyMap[e.code];
    if (action) {
      this.held.delete(action);
      e.preventDefault();
    }
  }

  getActions() {
    return this.held;
  }

  getJustPressed() {
    return this.justPressed;
  }

  endFrame() {
    this.justPressed.clear();
  }
}

// ─────────────────────────────────────────────
// Default P1 keyboard layout
// ─────────────────────────────────────────────
export const P1_KEYBOARD_MAP = {
  'KeyW': Actions.UP,
  'KeyS': Actions.DOWN,
  'KeyA': Actions.LEFT,
  'KeyD': Actions.RIGHT,
  'KeyU': Actions.LIGHT_PUNCH,
  'KeyI': Actions.MEDIUM_PUNCH,
  'KeyO': Actions.HEAVY_PUNCH,
  'KeyJ': Actions.LIGHT_KICK,
  'KeyK': Actions.MEDIUM_KICK,
  'KeyL': Actions.HEAVY_KICK,
};

export const P2_KEYBOARD_MAP = {
  'ArrowUp': Actions.UP,
  'ArrowDown': Actions.DOWN,
  'ArrowLeft': Actions.LEFT,
  'ArrowRight': Actions.RIGHT,
  'Numpad4': Actions.LIGHT_PUNCH,
  'Numpad5': Actions.MEDIUM_PUNCH,
  'Numpad6': Actions.HEAVY_PUNCH,
  'Numpad1': Actions.LIGHT_KICK,
  'Numpad2': Actions.MEDIUM_KICK,
  'Numpad3': Actions.HEAVY_KICK,
};
