import { InputManager, KeyboardAdapter, P1_KEYBOARD_MAP, P2_KEYBOARD_MAP } from './input.js';
import { Game } from './game.js';
import { SFX } from './sfx.js';
import { INPUT_MODES, LLM_PROVIDERS, updateModeSelection, updateControlsInfo, getPlayerLabel } from './ui.js';
import { VoiceAdapter } from './voice.js';
import { PhoneAdapter } from './phone.js';
import { SimulatedAdapter } from './simulated.js';
import { LLMAdapter } from './llm.js';
import { parseRoute } from './router.js';
import { isAuthConfigured, login, logout, handleCallback, checkAuth, isLoggedIn, getUser } from './auth.js';

const canvas = document.getElementById('game');

// Screen elements
const screens = {
  landing: document.getElementById('landing'),
  multiplayer: document.getElementById('multiplayer-menu'),
  joinRoom: document.getElementById('join-room'),
  roomLobby: document.getElementById('room-lobby'),
  roomController: document.getElementById('room-controller'),
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
    startRoomPolling(); // Poll until P2 joins → status becomes "selecting"
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

    // P2 joins → room is now "selecting" → go straight to controller selection
    showRoomControllerScreen();
    startRoomPolling();
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
document.getElementById('btn-lobby-back').addEventListener('click', () => {
  stopRoomPolling();
  showScreen('multiplayer');
});
document.getElementById('btn-copy-url').addEventListener('click', () => {
  const url = document.getElementById('room-url-display').value;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('btn-copy-url');
    btn.textContent = 'COPIED';
    setTimeout(() => { btn.textContent = 'COPY'; }, 1500);
  });
});

// ─────────────────────────────────────────────
// Room status polling
// ─────────────────────────────────────────────
let roomPollTimer = null;

function stopRoomPolling() {
  if (roomPollTimer) {
    clearInterval(roomPollTimer);
    roomPollTimer = null;
  }
}

function startRoomPolling() {
  stopRoomPolling();
  const code = localStorage.getItem('sf_roomCode');
  if (!code) return;

  roomPollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/room/status?code=${encodeURIComponent(code)}`);
      if (!resp.ok) {
        console.warn('[room-poll] Status check failed:', resp.status);
        return;
      }
      const data = await resp.json();
      handleRoomStatusUpdate(data);
    } catch (err) {
      console.warn('[room-poll] Error:', err);
    }
  }, 2000);
}

function handleRoomStatusUpdate(data) {
  const myNum = localStorage.getItem('sf_playerNum');

  if (data.status === 'selecting' && state === 'roomLobby') {
    // Both players in room — go to controller selection
    showRoomControllerScreen();
  } else if (data.status === 'fighting') {
    // Both controllers confirmed — start the fight
    stopRoomPolling();
    startMultiplayerFight(data);
  }

  // Update controller status text on room-controller screen
  if (state === 'roomController') {
    const statusEl = document.getElementById('room-ctrl-status');
    const opponentNum = myNum === '1' ? '2' : '1';
    const opponentReady = data[`p${opponentNum}Ready`];
    const myReady = data[`p${myNum}Ready`];

    if (myReady && opponentReady) {
      statusEl.textContent = 'Both ready — starting match!';
      statusEl.classList.add('ready');
    } else if (myReady && !opponentReady) {
      statusEl.textContent = 'Waiting for opponent to select controller...';
      statusEl.classList.remove('ready');
    } else if (!myReady && opponentReady) {
      statusEl.textContent = 'Opponent is ready — pick your controller!';
      statusEl.classList.remove('ready');
    } else {
      statusEl.textContent = 'Both players selecting controllers...';
      statusEl.classList.remove('ready');
    }
  }
}

// ─────────────────────────────────────────────
// Room controller selection screen
// ─────────────────────────────────────────────
let roomModeIdx = 0;
let roomProviderIdx = 0;

function showRoomControllerScreen() {
  const myNum = localStorage.getItem('sf_playerNum') || '1';
  const card = document.getElementById('room-ctrl-card');
  const playerLabel = document.getElementById('room-ctrl-player');
  const confirmBtn = document.getElementById('btn-ctrl-confirm');

  // Style card based on player number
  card.classList.remove('p1', 'p2');
  card.classList.add(myNum === '1' ? 'p1' : 'p2');
  playerLabel.textContent = `PLAYER ${myNum}`;

  // Reset selection
  roomModeIdx = 0;
  roomProviderIdx = 0;
  confirmBtn.disabled = false;
  confirmBtn.textContent = 'CONFIRM';
  document.getElementById('room-ctrl-status').textContent = 'Both players selecting controllers...';
  document.getElementById('room-ctrl-status').classList.remove('ready');

  updateRoomControllerUI();
  showScreen('roomController');
}

function updateRoomControllerUI() {
  // Update pill selection
  const pills = document.querySelectorAll('#room-ctrl-pills .mode-pill');
  pills.forEach((pill, i) => {
    pill.classList.toggle('selected', i === roomModeIdx);
  });

  // Update controls info using the existing ui.js function
  // We render into the room-ctrl-info element directly
  const infoEl = document.getElementById('room-ctrl-info');
  const mode = INPUT_MODES[roomModeIdx];

  if (mode.id === 'controller') {
    const myNum = localStorage.getItem('sf_playerNum') || '1';
    const controls = myNum === '1'
      ? [{ keys: ['W', 'A', 'S', 'D'], label: 'move' }, { keys: ['U', 'I', 'O'], label: 'punch' }, { keys: ['J', 'K', 'L'], label: 'kick' }]
      : [{ keys: ['↑', '←', '↓', '→'], label: 'move' }, { keys: ['4', '5', '6'], label: 'punch' }, { keys: ['1', '2', '3'], label: 'kick' }];
    infoEl.innerHTML = controls.map(row =>
      `<div class="control-row">${row.keys.map(k => `<kbd>${k}</kbd>`).join(' ')} ${row.label}</div>`
    ).join('') + `<div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'voice') {
    infoEl.innerHTML = `<div class="voice-info">"punch" "kick" "jump"<br><span>"hard punch" "forward" "back"</span></div><div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'phone') {
    infoEl.innerHTML = `<div class="voice-info">Call a phone number<br><span>Shout commands into the phone</span></div><div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'simulated') {
    infoEl.innerHTML = `<div class="llm-info">Random command bot<br><span>Lightweight, no API key needed</span></div><div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'llm') {
    const provider = LLM_PROVIDERS[roomProviderIdx] || LLM_PROVIDERS[0];
    const providerPills = LLM_PROVIDERS.map((p, i) =>
      `<button class="provider-pill${i === roomProviderIdx ? ' selected' : ''}" data-provider="${i}">${p.label}</button>`
    ).join('');
    infoEl.innerHTML = `<div class="provider-pills" data-player="room">${providerPills}</div><div class="llm-info">${provider.label} ${provider.model}<br><span>Tactical AI with game awareness</span></div><div class="mode-desc">${mode.desc}</div>`;
  }
}

// Mode pill clicks on room controller screen
document.getElementById('room-ctrl-pills').addEventListener('click', e => {
  const pill = e.target.closest('.mode-pill');
  if (!pill) return;
  roomModeIdx = parseInt(pill.dataset.mode, 10);
  updateRoomControllerUI();
});

// LLM provider pill clicks (delegated from room-ctrl-info)
document.getElementById('room-ctrl-info').addEventListener('click', e => {
  const pill = e.target.closest('.provider-pill');
  if (!pill) return;
  roomProviderIdx = parseInt(pill.dataset.provider, 10);
  updateRoomControllerUI();
});

// Confirm controller choice
document.getElementById('btn-ctrl-confirm').addEventListener('click', async () => {
  const code = localStorage.getItem('sf_roomCode');
  const playerId = localStorage.getItem('sf_playerId');
  const controller = INPUT_MODES[roomModeIdx].id;
  const confirmBtn = document.getElementById('btn-ctrl-confirm');

  confirmBtn.disabled = true;
  confirmBtn.textContent = 'CONFIRMED';

  try {
    const resp = await fetch('/api/room/controller', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, playerId, controller }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[room-ctrl] Failed:', err.detail || resp.status);
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'CONFIRM';
      return;
    }

    const data = await resp.json();
    if (data.bothReady) {
      stopRoomPolling();
      startMultiplayerFight(data);
    }
  } catch (err) {
    console.error('[room-ctrl] Error:', err);
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'CONFIRM';
  }
});

// Back button on controller screen
document.getElementById('btn-ctrl-back').addEventListener('click', () => {
  stopRoomPolling();
  showScreen('multiplayer');
});

/** Start a multiplayer fight using the locally selected controller */
function startMultiplayerFight(_roomData) {
  const myNum = parseInt(localStorage.getItem('sf_playerNum') || '1', 10);

  state = 'fighting';
  for (const el of Object.values(screens)) el.classList.add('hidden');
  canvas.classList.add('active');
  resize();

  // Create input for local player based on room controller selection
  const localInput = createInput(myNum, roomModeIdx, roomProviderIdx);

  // Remote player gets a no-op InputManager (networking wired in US-012)
  const remoteInput = new InputManager();

  const myInput = myNum === 1 ? localInput : remoteInput;
  const opInput = myNum === 1 ? remoteInput : localInput;

  const myLabel = getPlayerLabel(roomModeIdx, roomProviderIdx);
  const opLabel = 'Remote';

  const p1Label = myNum === 1 ? myLabel : opLabel;
  const p2Label = myNum === 1 ? opLabel : myLabel;

  // Preload SFX + adapters
  const readyPromises = [sfx.preload()];
  for (const adapter of activeAdapters) {
    if (adapter.waitUntilReady) readyPromises.push(adapter.waitUntilReady());
  }

  game = new Game(canvas, myInput, opInput, sfx, { p1Label, p2Label });
  game.start();

  for (const adapter of activeAdapters) {
    if (adapter.setGameRef) adapter.setGameRef(game);
  }

  window._game = game;
  Promise.all(readyPromises).then(() => game.showFightAlert());
}

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
    else if (state === 'roomLobby') { stopRoomPolling(); showScreen('multiplayer'); }
    else if (state === 'roomController') { stopRoomPolling(); showScreen('multiplayer'); }
    else if (state === 'onboarding') showScreen('landing');
  }
});

// ─────────────────────────────────────────────
// Auth UI — header login/user section
// ─────────────────────────────────────────────
const headerAuth = document.getElementById('header-auth');

/** Update the header auth section based on login state */
function updateAuthUI() {
  if (!headerAuth) return;

  if (isLoggedIn()) {
    const user = getUser();
    const name = user?.name || 'User';
    headerAuth.innerHTML = `
      <span class="auth-user-name">${name}</span>
      <button class="auth-logout-btn" id="btn-auth-logout">LOG OUT</button>
    `;
    headerAuth.classList.remove('hidden');
    document.getElementById('btn-auth-logout')?.addEventListener('click', () => {
      logout();
      updateAuthUI();
    });
  } else {
    // Show login button only if OIDC is configured (check cached config)
    headerAuth.innerHTML = `
      <button class="auth-login-btn" id="btn-auth-login">LOG IN</button>
    `;
    // Will be shown/hidden after config check
    headerAuth.classList.add('hidden');
  }
}

/** Initialize auth — check config, handle callback, restore session */
async function initAuth() {
  const configured = await isAuthConfigured();

  if (!configured) {
    // OIDC not configured — hide auth UI entirely
    headerAuth?.classList.add('hidden');
    return;
  }

  // Check if this is an auth callback
  const route = parseRoute();
  if (route.type === 'auth-callback') {
    const user = await handleCallback();
    if (user) {
      console.log('[auth] Logged in as:', user.name);
    }
    updateAuthUI();
    showScreen('landing');
    return true; // Signal that we handled the route
  }

  // Try to restore existing session (refresh token if needed)
  await checkAuth();
  updateAuthUI();

  // Show login button for anonymous users
  if (!isLoggedIn()) {
    headerAuth?.classList.remove('hidden');
    document.getElementById('btn-auth-login')?.addEventListener('click', login);
  }

  return false;
}

// ─────────────────────────────────────────────
// URL routing — detect /room/:code or /auth/callback on load
// ─────────────────────────────────────────────
const route = parseRoute();

// Initialize auth (may handle callback route)
initAuth().then(handledRoute => {
  if (handledRoute) return; // Auth callback was handled

  if (route.type === 'room') {
    // Auto-join room from URL — show join screen with code pre-filled, then attempt join
    showScreen('joinRoom');
    roomCodeInput.value = route.code;
    joinGoBtn.disabled = false;
    joinRoom(route.code);
  } else if (route.type !== 'auth-callback') {
    showScreen('landing');
  }
});
