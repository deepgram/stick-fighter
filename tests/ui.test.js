/**
 * Tests for P2 keyboard exclusion in classic mode.
 */

// Import INPUT_MODES directly — ui.js uses `document` lazily (only in getDG/updateModeSelection),
// so we need a minimal DOM stub for the module to load.
// Provide getComputedStyle stub so getDG() doesn't blow up if triggered.
globalThis.document = {
  documentElement: {},
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => {
    const el = { tagName: tag, textContent: '', innerHTML: '', style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {} };
    return el;
  },
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const { INPUT_MODES } = await import('../src/ui.js');

describe('INPUT_MODES P2 keyboard exclusion', () => {
  test('keyboard mode has p2Disabled flag', () => {
    const kbd = INPUT_MODES.find(m => m.id === 'controller');
    expect(kbd).toBeDefined();
    expect(kbd.p2Disabled).toBe(true);
  });

  test('non-keyboard modes do not have p2Disabled', () => {
    const others = INPUT_MODES.filter(m => m.id !== 'controller');
    for (const mode of others) {
      expect(mode.p2Disabled).toBeFalsy();
    }
  });

  test('P2 valid modes are phone, simulated, and LLM (excluding p1Only and p2Disabled)', () => {
    const validP2 = INPUT_MODES.filter(m => !m.p1Only && !m.p2Disabled);
    const ids = validP2.map(m => m.id);
    expect(ids).toEqual(expect.arrayContaining(['phone', 'simulated', 'llm']));
    expect(ids).not.toContain('controller');
  });

  test('P1 can still use keyboard (no p1Only on controller)', () => {
    const kbd = INPUT_MODES.find(m => m.id === 'controller');
    expect(kbd.p1Only).toBeFalsy();
  });

  test('keyboard navigation skip logic works for P2', () => {
    // Simulate the do-while skip used in main.js for P2 ArrowRight
    const modeCount = INPUT_MODES.length;
    let p2ModeIdx = 2; // start at phone
    // Go right from phone → should skip to simulated (3), not keyboard (0) or voice (1)
    do {
      p2ModeIdx = (p2ModeIdx + 1) % modeCount;
    } while (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled);
    expect(p2ModeIdx).toBe(3); // simulated

    // Keep going right → LLM (4)
    do {
      p2ModeIdx = (p2ModeIdx + 1) % modeCount;
    } while (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled);
    expect(p2ModeIdx).toBe(4); // llm

    // Keep going right → should wrap past keyboard(0) and voice(1) to phone(2)
    do {
      p2ModeIdx = (p2ModeIdx + 1) % modeCount;
    } while (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled);
    expect(p2ModeIdx).toBe(2); // phone
  });

  test('P2 init guard bumps keyboard to valid mode', () => {
    // Simulate the init logic from main.js
    let p2ModeIdx = 0; // keyboard (saved in localStorage)
    if (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled) {
      p2ModeIdx = 3; // simulated fallback
    }
    expect(p2ModeIdx).toBe(3);
  });
});

describe('INPUT_MODES MP controller restriction', () => {
  test('simulated mode has mpDisabled flag', () => {
    const sim = INPUT_MODES.find(m => m.id === 'simulated');
    expect(sim).toBeDefined();
    expect(sim.mpDisabled).toBe(true);
  });

  test('llm mode has mpDisabled flag', () => {
    const llm = INPUT_MODES.find(m => m.id === 'llm');
    expect(llm).toBeDefined();
    expect(llm.mpDisabled).toBe(true);
  });

  test('keyboard, voice, phone do not have mpDisabled', () => {
    const mpModes = INPUT_MODES.filter(m => ['controller', 'voice', 'phone'].includes(m.id));
    for (const mode of mpModes) {
      expect(mode.mpDisabled).toBeFalsy();
    }
  });

  test('valid MP modes are exactly keyboard, voice, phone', () => {
    const validMP = INPUT_MODES.filter(m => !m.mpDisabled);
    const ids = validMP.map(m => m.id);
    expect(ids).toEqual(['controller', 'voice', 'phone']);
  });

  test('single-player still has all 5 modes', () => {
    expect(INPUT_MODES).toHaveLength(5);
    const ids = INPUT_MODES.map(m => m.id);
    expect(ids).toEqual(['controller', 'voice', 'phone', 'simulated', 'llm']);
  });
});
