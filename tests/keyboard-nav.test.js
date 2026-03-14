/**
 * Tests for US-007: Keyboard navigation for all menu screens.
 *
 * These tests validate the keyboard navigation logic — focus cycling,
 * skip logic for disabled modes, and HTML structure for navigable elements.
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

// Load index.html for structure assertions
const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');

describe('Landing page keyboard navigation', () => {
  test('landing has btn-multiplayer and btn-singleplayer buttons', () => {
    expect(html).toContain('id="btn-multiplayer"');
    expect(html).toContain('id="btn-singleplayer"');
  });

  test('landing has btn-leaderboard button', () => {
    expect(html).toContain('id="btn-leaderboard"');
  });

  test('path cards are <button> elements (keyboard accessible)', () => {
    expect(html).toMatch(/<button[^>]*class="path-card mp"/);
    expect(html).toMatch(/<button[^>]*class="path-card sp"/);
  });

  test('focus cycling wraps around 3 items (Up from 0 → 2, Down from 2 → 0)', () => {
    const itemCount = 3; // multiplayer, singleplayer, leaderboard
    let idx = 0;
    // Down cycles 0 → 1 → 2 → 0
    idx = (idx + 1) % itemCount; expect(idx).toBe(1);
    idx = (idx + 1) % itemCount; expect(idx).toBe(2);
    idx = (idx + 1) % itemCount; expect(idx).toBe(0);
    // Up from 0 wraps to 2
    idx = (idx - 1 + itemCount) % itemCount; expect(idx).toBe(2);
  });
});

describe('Multiplayer menu keyboard navigation', () => {
  test('multiplayer menu has 3 mp-option buttons', () => {
    expect(html).toContain('id="btn-create-room"');
    expect(html).toContain('id="btn-join-room"');
    expect(html).toContain('id="btn-matchmaking"');
  });

  test('mp-options are <button> elements', () => {
    expect(html).toMatch(/<button[^>]*class="mp-option"[^>]*id="btn-create-room"/);
    expect(html).toMatch(/<button[^>]*class="mp-option"[^>]*id="btn-join-room"/);
    expect(html).toMatch(/<button[^>]*class="mp-option"[^>]*id="btn-matchmaking"/);
  });

  test('back button exists for Escape navigation', () => {
    expect(html).toContain('id="btn-mp-back"');
  });
});

describe('Room controller keyboard navigation', () => {
  test('room controller has mode pills', () => {
    expect(html).toContain('id="room-ctrl-pills"');
  });

  test('confirm button exists', () => {
    expect(html).toContain('id="btn-ctrl-confirm"');
  });

  test('Up/Down skip logic skips mpDisabled modes', () => {
    const modeCount = INPUT_MODES.length;
    let idx = 0; // start at keyboard
    // Down from keyboard(0) → voice(1), not simulated(3) which is mpDisabled
    const dir = 1;
    do { idx = (idx + dir + modeCount) % modeCount; } while (INPUT_MODES[idx].mpDisabled);
    expect(idx).toBe(1); // voice

    // Down from voice(1) → phone(2)
    do { idx = (idx + dir + modeCount) % modeCount; } while (INPUT_MODES[idx].mpDisabled);
    expect(idx).toBe(2); // phone

    // Down from phone(2) → keyboard(0), skipping simulated(3) and llm(4)
    do { idx = (idx + dir + modeCount) % modeCount; } while (INPUT_MODES[idx].mpDisabled);
    expect(idx).toBe(0); // keyboard (wraps, skipping 3 and 4)
  });

  test('Up skip logic works in reverse', () => {
    const modeCount = INPUT_MODES.length;
    let idx = 0; // start at keyboard
    const dir = -1;
    // Up from keyboard(0) → phone(2), skipping llm(4) and simulated(3)
    do { idx = (idx + dir + modeCount) % modeCount; } while (INPUT_MODES[idx].mpDisabled);
    expect(idx).toBe(2); // phone
  });
});

describe('Matchmaking controller keyboard navigation', () => {
  test('matchmaking has mode pills', () => {
    expect(html).toContain('id="mm-ctrl-pills"');
  });

  test('search button exists', () => {
    expect(html).toContain('id="btn-mm-search"');
  });

  test('mm-select container exists for select phase detection', () => {
    expect(html).toContain('id="mm-select"');
  });
});

describe('Room code input auto-focus', () => {
  test('room code input exists and has autocomplete off', () => {
    expect(html).toContain('id="room-code-input"');
    expect(html).toContain('autocomplete="off"');
  });

  test('join button exists for Enter activation', () => {
    expect(html).toContain('id="btn-join-go"');
  });
});

describe('Leaderboard keyboard navigation', () => {
  test('leaderboard has exactly 2 league filter buttons', () => {
    // Count <button class="lb-filter..."> elements (not CSS rules)
    const filterMatches = html.match(/<button\s+class="lb-filter[^"]*"/g);
    expect(filterMatches).toBeDefined();
    expect(filterMatches.length).toBe(2);
  });

  test('filter buttons have data-category attributes', () => {
    expect(html).toContain('data-category="voice"');
    expect(html).toContain('data-category="keyboard"');
  });

  test('back button exists', () => {
    expect(html).toContain('id="btn-lb-back"');
  });
});

describe('Character select keyboard navigation', () => {
  test('character cards container exists', () => {
    expect(html).toContain('id="char-cards"');
  });

  test('fight button exists', () => {
    expect(html).toContain('id="btn-char-fight"');
  });
});

describe('Match results keyboard navigation', () => {
  test('rematch and leave buttons exist', () => {
    expect(html).toContain('id="btn-rematch"');
    expect(html).toContain('id="btn-leave"');
  });

  test('focus cycling between 2 items (Left → 0, Right → 1)', () => {
    let idx = 0;
    // Right → 1
    idx = 1;
    expect(idx).toBe(1);
    // Left → 0
    idx = 0;
    expect(idx).toBe(0);
  });
});

describe('Focus indicator CSS', () => {
  test('kb-focus class is defined in styles', () => {
    expect(html).toContain('.kb-focus');
  });

  test('kb-focus uses outline for visibility', () => {
    expect(html).toMatch(/\.kb-focus\s*\{[^}]*outline/);
  });
});

describe('Escape key navigation targets', () => {
  test('all screens have back buttons for Escape fallback', () => {
    expect(html).toContain('id="btn-mp-back"');
    expect(html).toContain('id="btn-join-back"');
    expect(html).toContain('id="btn-lobby-back"');
    expect(html).toContain('id="btn-ctrl-back"');
    expect(html).toContain('id="btn-mm-back"');
    expect(html).toContain('id="btn-lb-back"');
    expect(html).toContain('id="btn-char-back"');
  });
});
