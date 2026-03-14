/**
 * Tests for US-005: Step indicators and instructions on all screens.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Minimal DOM stub for ui.js import
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

// Load index.html for static content assertions
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');

describe('Landing page', () => {
  test('has tagline explaining game modes', () => {
    expect(html).toContain('Fight online or train against AI');
  });

  test('tagline has proper CSS class', () => {
    expect(html).toContain('landing-tagline');
  });
});

describe('Multiplayer screen', () => {
  test('has step indicator with 3 steps', () => {
    expect(html).toContain('Step 1: Create or Join');
    expect(html).toContain('Step 2: Pick Controller');
    expect(html).toContain('Step 3: Fight!');
  });

  test('step indicator has proper CSS class', () => {
    expect(html).toContain('mp-steps');
  });
});

describe('Room creation screen', () => {
  test('has instruction text about sharing code', () => {
    expect(html).toContain('Share this code with your opponent');
  });

  test('has copy button', () => {
    expect(html).toContain('btn-copy-url');
    expect(html).toContain('COPY');
  });
});

describe('Room join screen', () => {
  test('has placeholder with example format', () => {
    expect(html).toContain('placeholder="e.g. red-tiger-paw"');
  });
});

describe('Controller selection descriptions', () => {
  test('keyboard mode has descriptive label', () => {
    const kbd = INPUT_MODES.find(m => m.id === 'controller');
    expect(kbd.desc).toMatch(/keyboard/i);
    expect(kbd.desc).toMatch(/arrow keys|Z\/X/i);
  });

  test('voice mode has descriptive label', () => {
    const voice = INPUT_MODES.find(m => m.id === 'voice');
    expect(voice.desc).toMatch(/voice/i);
    expect(voice.desc).toMatch(/mic/i);
  });

  test('phone mode has descriptive label', () => {
    const phone = INPUT_MODES.find(m => m.id === 'phone');
    expect(phone.desc).toMatch(/phone/i);
    expect(phone.desc).toMatch(/call in/i);
  });

  test('all modes have a desc field', () => {
    for (const mode of INPUT_MODES) {
      expect(mode.desc).toBeDefined();
      expect(typeof mode.desc).toBe('string');
      expect(mode.desc.length).toBeGreaterThan(0);
    }
  });
});

describe('Matchmaking queue text', () => {
  test('matchmaking searching element exists in HTML', () => {
    expect(html).toContain('id="mm-searching-text"');
    expect(html).toContain('Searching for opponent...');
  });
});

describe('Waiting for opponent text', () => {
  test('room controller screen has status element', () => {
    expect(html).toContain('id="room-ctrl-status"');
  });
});
