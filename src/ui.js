// ─────────────────────────────────────────────
// Shared design tokens — reads from CSS custom properties
// so both HTML and canvas use the same values
// ─────────────────────────────────────────────

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Lazy-loaded from CSS vars (call after DOM ready)
let _dg = null;
export function getDG() {
  if (!_dg) {
    _dg = {
      primary:   getCSSVar('--dg-primary'),
      secondary: getCSSVar('--dg-secondary'),
      almostBlk: getCSSVar('--dg-almost-blk'),
      bg:        getCSSVar('--dg-bg'),
      charcoal:  getCSSVar('--dg-charcoal'),
      border:    getCSSVar('--dg-border'),
      pebble:    getCSSVar('--dg-pebble'),
      slate:     getCSSVar('--dg-slate'),
      text:      getCSSVar('--dg-text'),
      gradStart: getCSSVar('--dg-grad-start'),
      gradEnd:   getCSSVar('--dg-grad-end'),
      danger:    getCSSVar('--dg-danger'),
    };
  }
  return _dg;
}

// Alias for convenience
export const DG = new Proxy({}, { get: (_, key) => getDG()[key] });

// ─────────────────────────────────────────────
// Player input modes
// ─────────────────────────────────────────────
export const INPUT_MODES = [
  { id: 'controller', label: 'Keys',  desc: 'Keyboard — use arrow keys and Z/X', p2Disabled: true },
  { id: 'voice',      label: 'Voice', desc: 'Voice — speak commands into your mic', p1Only: true },
  { id: 'phone',      label: 'Phone', desc: 'Phone — call in from your phone' },
  { id: 'simulated',  label: 'Sim',   desc: 'Simulated — random AI commands', mpDisabled: true },
  { id: 'llm',        label: 'LLM',   desc: 'LLM — tactical AI with game awareness', mpDisabled: true },
];

// ─────────────────────────────────────────────
// LLM providers — sub-selection when LLM mode is picked
// ─────────────────────────────────────────────
export const LLM_PROVIDERS = [
  { id: 'anthropic', label: 'Claude',  model: 'Haiku 4.5' },
  { id: 'openai',    label: 'GPT-4o',  model: '4o mini' },
];

// ─────────────────────────────────────────────
// Controls info HTML generators
// ─────────────────────────────────────────────
const P1_CONTROLS = [
  { keys: ['W', 'A', 'S', 'D'], label: 'move' },
  { keys: ['U', 'I', 'O'], label: 'punch' },
  { keys: ['J', 'K', 'L'], label: 'kick' },
];

const P2_CONTROLS = [
  { keys: ['↑', '←', '↓', '→'], label: 'move' },
  { keys: ['4', '5', '6'], label: 'punch' },
  { keys: ['1', '2', '3'], label: 'kick' },
];

export function updateControlsInfo(playerNum, modeIdx, providerIdx = 0) {
  const el = document.querySelector(`.controls-info[data-player="${playerNum}"]`);
  if (!el) return;

  const mode = INPUT_MODES[modeIdx];

  if (mode.id === 'controller') {
    const controls = playerNum === 1 ? P1_CONTROLS : P2_CONTROLS;
    el.innerHTML = controls.map(row =>
      `<div class="control-row">${row.keys.map(k => `<kbd>${k}</kbd>`).join(' ')} ${row.label}</div>`
    ).join('') + `<div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'voice') {
    el.innerHTML = `
      <div class="voice-info">"punch" "kick" "jump"<br><span>"hard punch" "forward" "back"</span></div>
      <div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'phone') {
    el.innerHTML = `
      <div class="voice-info">Call a phone number<br><span>Shout commands into the phone</span></div>
      <div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'simulated') {
    el.innerHTML = `
      <div class="llm-info">Random command bot<br><span>Lightweight, no API key needed</span></div>
      <div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'llm') {
    const provider = LLM_PROVIDERS[providerIdx] || LLM_PROVIDERS[0];
    const providerPills = LLM_PROVIDERS.map((p, i) =>
      `<button class="provider-pill${i === providerIdx ? ' selected' : ''}" data-provider="${i}">${p.label}</button>`
    ).join('');
    el.innerHTML = `
      <div class="provider-pills" data-player="${playerNum}">${providerPills}</div>
      <div class="llm-info">${provider.label} ${provider.model}<br><span>Tactical AI with game awareness</span></div>
      <div class="mode-desc">${mode.desc}</div>`;
  }
}

export function getPlayerLabel(modeIdx, providerIdx = 0) {
  const mode = INPUT_MODES[modeIdx];
  if (mode.id === 'controller') return 'Keyboard';
  if (mode.id === 'voice') return 'Voice';
  if (mode.id === 'phone') return 'Phone';
  if (mode.id === 'simulated') return 'Simulated';
  if (mode.id === 'llm') return LLM_PROVIDERS[providerIdx]?.label || 'LLM';
  return mode.label;
}

export function updateModeSelection(playerNum, modeIdx, providerIdx = 0) {
  const pills = document.querySelectorAll(`.mode-pills[data-player="${playerNum}"] .mode-pill`);
  pills.forEach((pill, i) => {
    const mode = INPUT_MODES[i];
    // Disable modes restricted to other players
    if ((mode.p1Only && playerNum !== 1) || (mode.p2Disabled && playerNum === 2)) {
      pill.style.opacity = '0.3';
      pill.style.pointerEvents = 'none';
    }
    pill.classList.toggle('selected', i === modeIdx);
  });
  updateControlsInfo(playerNum, modeIdx, providerIdx);
}
