import { InputManager, KeyboardAdapter, P1_KEYBOARD_MAP, P2_KEYBOARD_MAP } from './input.js';
import { Game } from './game.js';
import { SFX } from './sfx.js';
import { INPUT_MODES, LLM_PROVIDERS, updateModeSelection, getPlayerLabel } from './ui.js';
import { VoiceAdapter } from './voice.js';
import { PhoneAdapter } from './phone.js';
import { SimulatedAdapter } from './simulated.js';
import { LLMAdapter } from './llm.js';
import { parseRoute } from './router.js';

const canvas = document.getElementById('game');

// Screen elements
const screens = {
  landing: document.getElementById('landing'),
  multiplayer: document.getElementById('multiplayer-menu'),
  joinRoom: document.getElementById('join-room'),
  roomLobby: document.getElementById('room-lobby'),
  onboarding: document.getElementById('onboarding'),
};

// Hi-DPI setup
const dpr = window.devicePixelRatio || 1;
function resize() {
  if (canvas.classList.contains('active')) {
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
  }
}
window.addEventListener('resize', resize);

// ─────────────────────────────────────────────
// Mode selection — persisted in localStorage
// ─────────────────────────────────────────────
let p1ModeIdx = parseInt(localStorage.getItem('sf_p1Mode') || '0', 10);
let p2ModeIdx = parseInt(localStorage.getItem('sf_p2Mode') || '0', 10);
let p1ProviderIdx = parseInt(localStorage.getItem('sf_p1Provider') || '0', 10);
let p2ProviderIdx = parseInt(localStorage.getItem('sf_p2Provider') || '0', 10);
p1ModeIdx = Math.max(0, Math.min(p1ModeIdx, INPUT_MODES.length - 1));
p2ModeIdx = Math.max(0, Math.min(p2ModeIdx, INPUT_MODES.length - 1));
p1ProviderIdx = Math.max(0, Math.min(p1ProviderIdx, LLM_PROVIDERS.length - 1));
p2ProviderIdx = Math.max(0, Math.min(p2ProviderIdx, LLM_PROVIDERS.length - 1));
// Ensure P2 doesn't land on a P1-only mode
if (INPUT_MODES[p2ModeIdx].p1Only) p2ModeIdx = 0;

function saveModes() {
  localStorage.setItem('sf_p1Mode', p1ModeIdx.toString());
  localStorage.setItem('sf_p2Mode', p2ModeIdx.toString());
  localStorage.setItem('sf_p1Provider', p1ProviderIdx.toString());
  localStorage.setItem('sf_p2Provider', p2ProviderIdx.toString());
}

updateModeSelection(1, p1ModeIdx, p1ProviderIdx);
updateModeSelection(2, p2ModeIdx, p2ProviderIdx);

// ─────────────────────────────────────────────
// App state & screen navigation
// ─────────────────────────────────────────────
let state = 'landing';
let game = null;
let p1Input = null;
let p2Input = null;
const sfx = new SFX();
// Track active adapters for cleanup
let activeAdapters = [];

/** Show a screen by name, hiding all others */
function showScreen(name) {
  for (const el of Object.values(screens)) {
    el.classList.add('hidden');
  }
  canvas.classList.remove('active');
  if (screens[name]) {
    screens[name].classList.remove('hidden');
  }
  state = name;
}

/** Create an InputManager with the right adapter for a mode */
function createInput(playerNum, modeIdx, providerIdx) {
  const manager = new InputManager();
  const mode = INPUT_MODES[modeIdx].id;

  if (mode === 'controller') {
    const keyMap = playerNum === 1 ? P1_KEYBOARD_MAP : P2_KEYBOARD_MAP;
    const adapter = new KeyboardAdapter(keyMap);
    manager.addAdapter(adapter);
    activeAdapters.push(adapter);
  } else if (mode === 'voice') {
    const adapter = new VoiceAdapter(playerNum);
    manager.addAdapter(adapter);
    activeAdapters.push(adapter);
  } else if (mode === 'phone') {
    const adapter = new PhoneAdapter(playerNum);
    manager.addAdapter(adapter);
    activeAdapters.push(adapter);
  } else if (mode === 'simulated') {
    const adapter = new SimulatedAdapter(playerNum);
    manager.addAdapter(adapter);
    activeAdapters.push(adapter);
  } else if (mode === 'llm') {
    const provider = LLM_PROVIDERS[providerIdx]?.id || 'anthropic';
    const adapter = new LLMAdapter(playerNum, provider);
    manager.addAdapter(adapter);
    activeAdapters.push(adapter);
  }

  return manager;
}

/** Clean up all active adapters */
async function cleanupAdapters() {
  for (const adapter of activeAdapters) {
    if (adapter.detach) await adapter.detach();
  }
  activeAdapters = [];
}

function showOnboarding() {
  if (game) { game.running = false; game = null; }
  cleanupAdapters();
  p1Input = null;
  p2Input = null;
  showScreen('onboarding');
}

async function startFight() {
  state = 'fighting';
  screens.onboarding.classList.add('hidden');
  canvas.classList.add('active');
  resize();

  // Create inputs based on mode selection
  p1Input = createInput(1, p1ModeIdx, p1ProviderIdx);
  p2Input = createInput(2, p2ModeIdx, p2ProviderIdx);

  // Preload SFX + wait for all adapters to be ready (mic, WS, etc.)
  const readyPromises = [sfx.preload()];
  for (const adapter of activeAdapters) {
    if (adapter.waitUntilReady) readyPromises.push(adapter.waitUntilReady());
  }

  // Start the game loop (renders stage + fighters while waiting)
  const p1Label = getPlayerLabel(p1ModeIdx, p1ProviderIdx);
  const p2Label = getPlayerLabel(p2ModeIdx, p2ProviderIdx);
  game = new Game(canvas, p1Input, p2Input, sfx, { p1Label, p2Label });
  game.start();

  // Wire up adapters with game reference
  for (const adapter of activeAdapters) {
    if (adapter.setGameRef) adapter.setGameRef(game);
  }

  window._game = game;

  // Wait for all providers, then show "FIGHT!"
  await Promise.all(readyPromises);
  game.showFightAlert();
}

// ─────────────────────────────────────────────
// Landing page click handlers
// ─────────────────────────────────────────────
document.getElementById('btn-multiplayer').addEventListener('click', () => showScreen('multiplayer'));
document.getElementById('btn-singleplayer').addEventListener('click', () => showScreen('onboarding'));

// Multiplayer menu
document.getElementById('btn-create-room').addEventListener('click', async () => {
  try {
    const resp = await fetch('/api/room/create', { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    // Store room info for later use
    localStorage.setItem('sf_roomCode', data.code);
    localStorage.setItem('sf_playerId', data.playerId);
    localStorage.setItem('sf_playerNum', '1');
    // Show lobby in "created" mode (P1 perspective)
    document.getElementById('room-lobby-title').textContent = 'ROOM CREATED';
    document.getElementById('room-lobby-hint').textContent = 'Share this code with your opponent';
    document.getElementById('room-code-display').textContent = data.code;
    document.getElementById('room-url-display').value = data.url;
    document.getElementById('room-url-row').classList.remove('hidden');
    document.getElementById('room-waiting-text').textContent = 'Waiting for opponent...';
    showScreen('roomLobby');
  } catch (err) {
    console.error('[multiplayer] Failed to create room:', err);
  }
});
document.getElementById('btn-join-room').addEventListener('click', () => showScreen('joinRoom'));
document.getElementById('btn-matchmaking').addEventListener('click', () => {
  // Placeholder — wired up in US-015
  console.log('[multiplayer] Matchmaking — not yet implemented');
});
document.getElementById('btn-mp-back').addEventListener('click', () => showScreen('landing'));

// Join room
const roomCodeInput = document.getElementById('room-code-input');
const joinGoBtn = document.getElementById('btn-join-go');

roomCodeInput.addEventListener('input', () => {
  // Enable join button when input has a plausible room code
  joinGoBtn.disabled = roomCodeInput.value.trim().length < 3;
});

/** Join a room by code — calls the API, navigates to lobby on success */
async function joinRoom(code) {
  const joinError = document.getElementById('join-error');
  joinError.classList.add('hidden');
  joinError.textContent = '';

  try {
    const resp = await fetch('/api/room/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const detail = err.detail || `Failed to join (HTTP ${resp.status})`;
      joinError.textContent = detail;
      joinError.classList.remove('hidden');
      return;
    }

    const data = await resp.json();
    // Store room info for later WebSocket/WebRTC use
    localStorage.setItem('sf_roomCode', data.code);
    localStorage.setItem('sf_playerId', data.playerId);
    localStorage.setItem('sf_playerNum', data.playerNum);

    // Show lobby in "joined" mode (P2 perspective)
    document.getElementById('room-lobby-title').textContent = 'ROOM JOINED';
    document.getElementById('room-lobby-hint').textContent = 'Waiting for both players to select controllers';
    document.getElementById('room-code-display').textContent = data.code;
    document.getElementById('room-url-row').classList.add('hidden');
    document.getElementById('room-waiting-text').textContent = 'Waiting for opponent to be ready...';
    showScreen('roomLobby');
  } catch (err) {
    console.error('[multiplayer] Failed to join room:', err);
    joinError.textContent = 'Network error — could not reach server';
    joinError.classList.remove('hidden');
  }
}

joinGoBtn.addEventListener('click', () => {
  const code = roomCodeInput.value.trim().toLowerCase();
  if (code) joinRoom(code);
});

roomCodeInput.addEventListener('keydown', e => {
  if (e.code === 'Enter' && !joinGoBtn.disabled) {
    const code = roomCodeInput.value.trim().toLowerCase();
    if (code) joinRoom(code);
  }
});

document.getElementById('btn-join-back').addEventListener('click', () => {
  roomCodeInput.value = '';
  joinGoBtn.disabled = true;
  document.getElementById('join-error').classList.add('hidden');
  showScreen('multiplayer');
});

// Room lobby
document.getElementById('btn-lobby-back').addEventListener('click', () => showScreen('multiplayer'));
document.getElementById('btn-copy-url').addEventListener('click', () => {
  const url = document.getElementById('room-url-display').value;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-url');
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
  });
});

// ─────────────────────────────────────────────
// Click handlers for mode pills (onboarding)
// ─────────────────────────────────────────────
document.querySelectorAll('.mode-pills').forEach(container => {
  const player = parseInt(container.dataset.player, 10);
  container.addEventListener('click', e => {
    const pill = e.target.closest('.mode-pill');
    if (!pill) return;
    const idx = parseInt(pill.dataset.mode, 10);
    // Skip p1Only modes for other players
    if (INPUT_MODES[idx].p1Only && player !== 1) return;
    if (player === 1) {
      p1ModeIdx = idx;
      updateModeSelection(1, p1ModeIdx, p1ProviderIdx);
    } else {
      p2ModeIdx = idx;
      updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
    }
    saveModes();
  });
});

// ─────────────────────────────────────────────
// Click handlers for LLM provider pills (delegated)
// ─────────────────────────────────────────────
screens.onboarding.addEventListener('click', e => {
  const pill = e.target.closest('.provider-pill');
  if (!pill) return;
  const container = pill.closest('.provider-pills');
  if (!container) return;
  const player = parseInt(container.dataset.player, 10);
  const idx = parseInt(pill.dataset.provider, 10);
  if (player === 1) {
    p1ProviderIdx = idx;
    updateModeSelection(1, p1ModeIdx, p1ProviderIdx);
  } else {
    p2ProviderIdx = idx;
    updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
  }
  saveModes();
});

// ─────────────────────────────────────────────
// Keyboard handlers
// ─────────────────────────────────────────────
window.addEventListener('keydown', e => {
  const modeCount = INPUT_MODES.length;

  if (state === 'onboarding') {
    if (e.code === 'KeyA') {
      p1ModeIdx = (p1ModeIdx - 1 + modeCount) % modeCount;
      updateModeSelection(1, p1ModeIdx, p1ProviderIdx);
      saveModes();
    } else if (e.code === 'KeyD') {
      p1ModeIdx = (p1ModeIdx + 1) % modeCount;
      updateModeSelection(1, p1ModeIdx, p1ProviderIdx);
      saveModes();
    } else if (e.code === 'ArrowLeft') {
      do { p2ModeIdx = (p2ModeIdx - 1 + modeCount) % modeCount; } while (INPUT_MODES[p2ModeIdx].p1Only);
      updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
      saveModes();
      e.preventDefault();
    } else if (e.code === 'ArrowRight') {
      do { p2ModeIdx = (p2ModeIdx + 1) % modeCount; } while (INPUT_MODES[p2ModeIdx].p1Only);
      updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
      saveModes();
      e.preventDefault();
    } else if (e.code === 'Enter') {
      startFight();
    }
  } else if (state === 'fighting') {
    if (e.code === 'Enter' && game && game.roundOver) {
      showOnboarding();
    }
  }

  // Escape goes back from any sub-screen
  if (e.code === 'Escape') {
    if (state === 'multiplayer') showScreen('landing');
    else if (state === 'joinRoom') showScreen('multiplayer');
    else if (state === 'roomLobby') showScreen('multiplayer');
    else if (state === 'onboarding') showScreen('landing');
  }
});

// ─────────────────────────────────────────────
// URL routing — detect /room/:code on load
// ─────────────────────────────────────────────
const route = parseRoute();
if (route.type === 'room') {
  // Auto-join room from URL — show join screen with code pre-filled, then attempt join
  showScreen('joinRoom');
  roomCodeInput.value = route.code;
  joinGoBtn.disabled = false;
  joinRoom(route.code);
} else {
  showScreen('landing');
}
