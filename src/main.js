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
import { PeerConnection, RemoteInputAdapter } from './webrtc.js';
import { PredictionManager } from './prediction.js';

const canvas = document.getElementById('game');

// Screen elements
const screens = {
  landing: document.getElementById('landing'),
  multiplayer: document.getElementById('multiplayer-menu'),
  joinRoom: document.getElementById('join-room'),
  roomLobby: document.getElementById('room-lobby'),
  roomController: document.getElementById('room-controller'),
  matchmaking: document.getElementById('matchmaking'),
  leaderboard: document.getElementById('leaderboard'),
  matchResults: document.getElementById('match-results'),
  characterSelect: document.getElementById('character-select'),
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
// Ensure P2 doesn't land on a P1-only or P2-disabled mode
if (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled) p2ModeIdx = 3;

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
// Track active peer connection for multiplayer cleanup
let peerConnection = null;

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
function createInput(playerNum, modeIdx, providerIdx, character = null) {
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
    const adapter = new LLMAdapter(playerNum, provider, character);
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
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  p1Input = null;
  p2Input = null;
  showScreen('onboarding');
}

function showLanding() {
  if (game) { game.running = false; game = null; }
  cleanupAdapters();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  p1Input = null;
  p2Input = null;
  showScreen('landing');
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
document.getElementById('btn-singleplayer').addEventListener('click', () => showCharacterSelect());

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
document.getElementById('btn-matchmaking').addEventListener('click', () => showMatchmakingScreen());
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
  const roomCode = localStorage.getItem('sf_roomCode');
  const playerId = localStorage.getItem('sf_playerId');

  state = 'fighting';
  for (const el of Object.values(screens)) el.classList.add('hidden');
  canvas.classList.add('active');
  resize();

  // Create input for local player based on room controller selection
  const localInput = createInput(myNum, roomModeIdx, roomProviderIdx);

  // Remote player gets an InputManager with a RemoteInputAdapter
  // that receives inputs from the peer via WebRTC data channel
  const remoteInput = new InputManager();
  const remoteAdapter = new RemoteInputAdapter();
  remoteInput.addAdapter(remoteAdapter);

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

  // Establish WebRTC peer connection + game WebSocket
  if (roomCode && playerId) {
    peerConnection = new PeerConnection(roomCode, playerId, myNum);

    // Client-side prediction with rollback reconciliation
    const predictionManager = new PredictionManager(game, myNum);
    game.predictionManager = predictionManager;

    // Feed remote peer inputs into the RemoteInputAdapter
    peerConnection.onRemoteInput((msg) => {
      remoteAdapter.receiveInput(msg);
    });

    // Handle authoritative server state — prediction manager reconciles
    peerConnection.onServerState((msg) => {
      if (msg.type === 'state' && predictionManager) {
        predictionManager.applyServerState(msg);
      }
      if (msg.type === 'round_over' && game) {
        game.roundOver = true;
        handleMultiplayerRoundOver(msg);
      }
      if (msg.type === 'room_expired') {
        handleRoomExpired();
      }
    });

    peerConnection.connect();

    // Tap into localInput.endFrame to buffer inputs for replay and send
    // to peer + server. Captures the exact actions the game loop just consumed.
    const origEndFrame = localInput.endFrame.bind(localInput);
    localInput.endFrame = () => {
      if (peerConnection) {
        const actions = localInput.getActions();
        const pressed = localInput.getJustPressed();
        const seq = predictionManager.nextSeq();
        predictionManager.bufferInput(seq, actions, pressed, game._dt);
        peerConnection.sendInput(actions, pressed, seq);
      }
      origEndFrame();
    };
  }

  Promise.all(readyPromises).then(() => game.showFightAlert());
}

// ─────────────────────────────────────────────
// Multiplayer match results
// ─────────────────────────────────────────────

/** Handle the round_over message from the server */
async function handleMultiplayerRoundOver(msg) {
  // Brief delay so players see the KO on canvas before switching screens
  await new Promise(r => setTimeout(r, 2000));

  // Stop the game and clean up peer connection
  if (game) { game.running = false; }
  cleanupAdapters();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }

  const myNum = parseInt(localStorage.getItem('sf_playerNum') || '1', 10);
  const roomCode = localStorage.getItem('sf_roomCode');
  const playerId = localStorage.getItem('sf_playerId');

  // Determine result text
  const winnerEl = document.getElementById('results-winner');
  winnerEl.classList.remove('p1-wins', 'p2-wins', 'draw');

  if (msg.winner === null || msg.winner === undefined) {
    winnerEl.textContent = 'DRAW!';
    winnerEl.classList.add('draw');
  } else if (msg.winner === myNum) {
    winnerEl.textContent = 'YOU WIN!';
    winnerEl.classList.add(myNum === 1 ? 'p1-wins' : 'p2-wins');
  } else {
    winnerEl.textContent = 'YOU LOSE';
    winnerEl.classList.add(msg.winner === 1 ? 'p1-wins' : 'p2-wins');
  }

  // Show reason for forfeit
  if (msg.reason === 'forfeit') {
    document.getElementById('results-title').textContent = 'OPPONENT DISCONNECTED';
  } else {
    document.getElementById('results-title').textContent = 'MATCH OVER';
  }

  // Health display
  document.getElementById('results-p1-hp').textContent =
    `P1: ${Math.max(0, Math.round(msg.p1_health))} HP`;
  document.getElementById('results-p2-hp').textContent =
    `P2: ${Math.max(0, Math.round(msg.p2_health))} HP`;

  // Call match complete endpoint with ELO data
  const user = isLoggedIn() ? getUser() : null;
  const body = {
    code: roomCode,
    playerId,
    winner: msg.winner,
    p1Health: msg.p1_health,
    p2Health: msg.p2_health,
  };

  // Add user info for ELO if logged in
  if (user) {
    if (myNum === 1) {
      body.p1UserId = user.sub || user.id;
      body.p1Name = user.name || 'Player';
    } else {
      body.p2UserId = user.sub || user.id;
      body.p2Name = user.name || 'Player';
    }
  }

  const eloEl = document.getElementById('results-elo');
  eloEl.classList.add('hidden');
  eloEl.innerHTML = '';

  try {
    const resp = await fetch('/api/match/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.ok) {
      const result = await resp.json();
      if (result.elo?.updated) {
        showEloChanges(result.elo, myNum);
      }
    }
  } catch (err) {
    console.warn('[match] Failed to report match result:', err);
  }

  // Show results screen
  canvas.classList.remove('active');
  showScreen('matchResults');
  game = null;
}

/** Display ELO rating changes on the results screen */
function showEloChanges(elo, myNum) {
  const eloEl = document.getElementById('results-elo');
  const myElo = myNum === 1 ? elo.p1 : elo.p2;
  const opElo = myNum === 1 ? elo.p2 : elo.p1;

  if (!myElo) return;

  const ratingChange = myElo.rating - 1000; // Approximate — rating was updated
  const changeClass = ratingChange > 0 ? 'elo-positive' : ratingChange < 0 ? 'elo-negative' : 'elo-neutral';

  eloEl.innerHTML = `
    <div class="elo-change">
      <span class="${changeClass}">Your ELO: ${Math.round(myElo.rating)}</span>
      <br><small>${elo.category} | W:${myElo.wins} L:${myElo.losses}</small>
    </div>
  `;
  if (opElo) {
    eloEl.innerHTML += `
      <div class="elo-change">
        <span class="elo-neutral">Opponent: ${Math.round(opElo.rating)}</span>
      </div>
    `;
  }
  eloEl.classList.remove('hidden');
}

/** Handle room expiry — server cleaned up the room due to inactivity TTL */
function handleRoomExpired() {
  console.log('[room] Room expired due to inactivity');
  // Stop game and clean up all connections gracefully
  if (game) { game.running = false; game = null; }
  cleanupAdapters();
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  stopRoomPolling();
  // Clear room data from localStorage
  localStorage.removeItem('sf_roomCode');
  localStorage.removeItem('sf_playerId');
  localStorage.removeItem('sf_playerNum');
  // Show landing with a brief alert
  showLanding();
  alert('Room expired due to inactivity.');
}

// Results screen: Rematch button
document.getElementById('btn-rematch').addEventListener('click', async () => {
  const roomCode = localStorage.getItem('sf_roomCode');
  const playerId = localStorage.getItem('sf_playerId');
  if (!roomCode || !playerId) { showLanding(); return; }

  try {
    const resp = await fetch('/api/room/rematch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: roomCode, playerId }),
    });

    if (!resp.ok) {
      console.warn('[rematch] Failed:', resp.status);
      showLanding();
      return;
    }

    // Back to controller selection
    showRoomControllerScreen();
    startRoomPolling();
  } catch (err) {
    console.warn('[rematch] Error:', err);
    showLanding();
  }
});

// Results screen: Leave button
document.getElementById('btn-leave').addEventListener('click', () => {
  localStorage.removeItem('sf_roomCode');
  localStorage.removeItem('sf_playerId');
  localStorage.removeItem('sf_playerNum');
  showLanding();
});

// ─────────────────────────────────────────────
// Matchmaking
// ─────────────────────────────────────────────
let mmModeIdx = 0;
let mmProviderIdx = 0;
let mmPlayerId = null;
let mmPollTimer = null;
let mmWaitingGame = false;

/** Map controller id to ELO category (mirrors elo.py) */
function controllerToCategory(controller) {
  if (controller === 'controller' || controller === 'keyboard') return 'keyboard';
  if (controller === 'voice' || controller === 'phone') return 'voice';
  return null;
}

function showMatchmakingScreen() {
  mmModeIdx = 0;
  mmProviderIdx = 0;
  mmPlayerId = null;
  document.getElementById('mm-select').classList.remove('hidden');
  document.getElementById('mm-searching').classList.add('hidden');
  updateMatchmakingControllerUI();
  showScreen('matchmaking');
}

function updateMatchmakingControllerUI() {
  const pills = document.querySelectorAll('#mm-ctrl-pills .mode-pill');
  pills.forEach((pill, i) => pill.classList.toggle('selected', i === mmModeIdx));

  const mode = INPUT_MODES[mmModeIdx];
  const category = controllerToCategory(mode.id);
  const searchBtn = document.getElementById('btn-mm-search');
  const infoEl = document.getElementById('mm-ctrl-info');

  if (category === null) {
    searchBtn.disabled = true;
    infoEl.innerHTML = '<div class="mm-warn">Bot controllers are not eligible for ranked matchmaking</div>';
    return;
  }

  searchBtn.disabled = false;

  if (mode.id === 'controller') {
    const controls = [
      { keys: ['W', 'A', 'S', 'D'], label: 'move' },
      { keys: ['U', 'I', 'O'], label: 'punch' },
      { keys: ['J', 'K', 'L'], label: 'kick' },
    ];
    infoEl.innerHTML = controls.map(row =>
      `<div class="control-row">${row.keys.map(k => `<kbd>${k}</kbd>`).join(' ')} ${row.label}</div>`
    ).join('') + `<div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'voice') {
    infoEl.innerHTML = `<div class="voice-info">"punch" "kick" "jump"<br><span>"hard punch" "forward" "back"</span></div><div class="mode-desc">${mode.desc}</div>`;
  } else if (mode.id === 'phone') {
    infoEl.innerHTML = `<div class="voice-info">Call a phone number<br><span>Shout commands into the phone</span></div><div class="mode-desc">${mode.desc}</div>`;
  }
}

// Mode pill clicks
document.getElementById('mm-ctrl-pills').addEventListener('click', e => {
  const pill = e.target.closest('.mode-pill');
  if (!pill) return;
  mmModeIdx = parseInt(pill.dataset.mode, 10);
  updateMatchmakingControllerUI();
});

// LLM provider pill clicks (delegated from mm-ctrl-info)
document.getElementById('mm-ctrl-info').addEventListener('click', e => {
  const pill = e.target.closest('.provider-pill');
  if (!pill) return;
  mmProviderIdx = parseInt(pill.dataset.provider, 10);
  updateMatchmakingControllerUI();
});

// Search button
document.getElementById('btn-mm-search').addEventListener('click', startMatchmakingSearch);

async function startMatchmakingSearch() {
  const controller = INPUT_MODES[mmModeIdx].id;
  const user = isLoggedIn() ? getUser() : null;

  try {
    const resp = await fetch('/api/matchmaking/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        controller,
        userId: user ? (user.sub || user.id || '') : '',
        name: user ? (user.name || '') : '',
      }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      console.error('[matchmaking] Join failed:', err.detail || resp.status);
      return;
    }

    const data = await resp.json();
    mmPlayerId = data.playerId;

    // Toggle to searching state
    document.getElementById('mm-select').classList.add('hidden');
    document.getElementById('mm-searching').classList.remove('hidden');
    document.getElementById('mm-searching-text').textContent = 'Searching for opponent...';
    document.getElementById('mm-wait-info').textContent =
      `Category: ${data.category} | ELO: ${Math.round(data.elo)} | Queue: ${data.queueSize}`;

    startMatchmakingPoll();
  } catch (err) {
    console.error('[matchmaking] Error:', err);
  }
}

function startMatchmakingPoll() {
  stopMatchmakingPoll();
  if (!mmPlayerId) return;

  mmPollTimer = setInterval(async () => {
    if (!mmPlayerId) return;
    try {
      const resp = await fetch(`/api/matchmaking/status?player_id=${encodeURIComponent(mmPlayerId)}`);
      if (!resp.ok) return;
      const data = await resp.json();
      handleMatchmakingStatus(data);
    } catch (err) {
      console.warn('[matchmaking] Poll error:', err);
    }
  }, 2000);
}

function stopMatchmakingPoll() {
  if (mmPollTimer) {
    clearInterval(mmPollTimer);
    mmPollTimer = null;
  }
}

function handleMatchmakingStatus(data) {
  if (data.status === 'matched') {
    stopMatchmakingPoll();
    handleMatchFound(data);
  } else if (data.status === 'searching') {
    document.getElementById('mm-wait-info').textContent =
      `Wait: ${data.waitTime}s | Queue: ${data.queueSize} | Threshold: \u00b1${data.threshold}`;
  } else if (data.status === 'not_queued') {
    // Player was removed (expired / pruned)
    stopMatchmakingPoll();
    mmPlayerId = null;
    if (mmWaitingGame) {
      if (game) { game.running = false; game = null; }
      cleanupAdapters();
      mmWaitingGame = false;
    }
    showMatchmakingScreen();
  }
}

function handleMatchFound(data) {
  // If playing a waiting game, stop it first
  if (mmWaitingGame) {
    if (game) { game.running = false; game = null; }
    cleanupAdapters();
    mmWaitingGame = false;
  }

  // Store room data (same pattern as room join)
  localStorage.setItem('sf_roomCode', data.roomCode);
  localStorage.setItem('sf_playerId', data.playerId);
  localStorage.setItem('sf_playerNum', String(data.playerNum));

  // Set controller indices for startMultiplayerFight
  roomModeIdx = mmModeIdx;
  roomProviderIdx = mmProviderIdx;

  mmPlayerId = null;
  startMultiplayerFight(data);
}

// Cancel button
document.getElementById('btn-mm-cancel').addEventListener('click', async () => {
  if (mmPlayerId) {
    await fetch('/api/matchmaking/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: mmPlayerId }),
    }).catch(() => {});
  }
  stopMatchmakingPoll();
  mmPlayerId = null;
  showMatchmakingScreen();
});

// Play while you wait
document.getElementById('btn-mm-play-wait').addEventListener('click', () => {
  mmWaitingGame = true;
  // Start a SIM fight — keys for P1, simulated for P2
  state = 'fighting';
  for (const el of Object.values(screens)) el.classList.add('hidden');
  canvas.classList.add('active');
  resize();

  const simInput1 = createInput(1, 0, 0); // Keys
  const simInput2 = createInput(2, 3, 0); // SIM

  game = new Game(canvas, simInput1, simInput2, sfx, { p1Label: 'You', p2Label: 'SIM Bot' });
  game.start();

  for (const adapter of activeAdapters) {
    if (adapter.setGameRef) adapter.setGameRef(game);
  }

  sfx.preload().then(() => game.showFightAlert());
  // Matchmaking poll continues in the background
});

// Back button
document.getElementById('btn-mm-back').addEventListener('click', () => {
  if (mmPlayerId) {
    fetch('/api/matchmaking/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: mmPlayerId }),
    }).catch(() => {});
    stopMatchmakingPoll();
    mmPlayerId = null;
  }
  showScreen('multiplayer');
});

// ─────────────────────────────────────────────
// Character select (single-player AI opponent)
// ─────────────────────────────────────────────
let selectedCharacter = null;
let characterList = [];

/** Fetch characters from server and show the character select screen */
async function showCharacterSelect() {
  showScreen('characterSelect');
  const fightBtn = document.getElementById('btn-char-fight');
  fightBtn.disabled = true;
  selectedCharacter = null;

  try {
    if (characterList.length === 0) {
      const resp = await fetch('/api/characters');
      if (resp.ok) characterList = await resp.json();
    }
    renderCharacterCards();
  } catch (err) {
    console.error('[character-select] Failed to load characters:', err);
  }
}

/** Render character cards into the grid */
function renderCharacterCards() {
  const container = document.getElementById('char-cards');
  container.innerHTML = characterList.map(c => `
    <button class="char-card${selectedCharacter === c.id ? ' selected' : ''}" data-char="${c.id}">
      <div class="char-icon">${c.icon}</div>
      <div class="char-name">${escapeHtml(c.name)}</div>
      <div class="char-provider">Powered by ${escapeHtml(c.provider)}</div>
      <div class="char-desc">${escapeHtml(c.description)}</div>
    </button>
  `).join('');

  // Attach click listeners
  container.querySelectorAll('.char-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedCharacter = card.dataset.char;
      container.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('btn-char-fight').disabled = false;
    });
  });
}

/** Start a fight against the selected character */
async function startCharacterFight() {
  if (!selectedCharacter) return;

  const char = characterList.find(c => c.id === selectedCharacter);
  if (!char) return;

  state = 'fighting';
  screens.characterSelect.classList.add('hidden');
  canvas.classList.add('active');
  resize();

  // P1 uses keyboard, P2 is the selected LLM character
  p1Input = createInput(1, 0, 0); // keyboard
  const p2Manager = new InputManager();
  const adapter = new LLMAdapter(2, char.provider, char.id);
  p2Manager.addAdapter(adapter);
  activeAdapters.push(adapter);
  p2Input = p2Manager;

  // Preload SFX + wait for adapters
  const readyPromises = [sfx.preload()];
  for (const a of activeAdapters) {
    if (a.waitUntilReady) readyPromises.push(a.waitUntilReady());
  }

  // Start game loop
  const p1Label = 'Keyboard';
  const p2Label = char.name;
  game = new Game(canvas, p1Input, p2Input, sfx, { p1Label, p2Label });
  game.start();

  // Wire adapter game ref
  for (const a of activeAdapters) {
    if (a.setGameRef) a.setGameRef(game);
  }

  window._game = game;

  await Promise.all(readyPromises);
  game.showFightAlert();
}

document.getElementById('btn-char-fight').addEventListener('click', () => startCharacterFight());
document.getElementById('btn-char-classic').addEventListener('click', () => {
  selectedCharacter = null;
  showScreen('onboarding');
});
document.getElementById('btn-char-back').addEventListener('click', () => showScreen('landing'));

// ─────────────────────────────────────────────
// Leaderboard
// ─────────────────────────────────────────────
/** Determine the default leaderboard league from the player's most recent controller. */
function defaultLeaderboardCategory() {
  const modeIdx = parseInt(localStorage.getItem('sf_p1Mode') || '0', 10);
  // INPUT_MODES: 0=controller(keyboard), 1=voice, 2=phone, 3=simulated, 4=llm
  if (modeIdx === 1 || modeIdx === 2) return 'voice';
  if (modeIdx === 0) return 'keyboard';
  return 'voice'; // default for non-ranked modes
}
let lbCategory = defaultLeaderboardCategory();

/** Fetch and render the leaderboard */
async function loadLeaderboard(category = lbCategory) {
  lbCategory = category;

  // Update filter button states
  document.querySelectorAll('#lb-filters .lb-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.category === category);
  });

  const body = document.getElementById('lb-body');
  const emptyEl = document.getElementById('lb-empty');
  const viewerRow = document.getElementById('lb-viewer-row');
  body.innerHTML = '';
  emptyEl.classList.add('hidden');
  viewerRow.classList.add('hidden');

  // Build URL with viewer's user ID if logged in
  let url = `/api/leaderboard?category=${encodeURIComponent(category)}`;
  const user = isLoggedIn() ? getUser() : null;
  const viewerId = user ? (user.sub || user.id || '') : '';
  if (viewerId) {
    url += `&user_id=${encodeURIComponent(viewerId)}`;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) return;
    const data = await resp.json();

    if (!data.entries || data.entries.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }

    // Render entries
    for (const entry of data.entries) {
      const isViewer = viewerId && String(entry.user_id) === viewerId;
      const tr = document.createElement('tr');
      if (isViewer) tr.classList.add('lb-viewer');
      const wl = `${entry.wins}W-${entry.losses}L` + (entry.draws ? `-${entry.draws}D` : '');
      const modeBadge = entry.input_mode || '';
      const badgeClass = modeBadge === 'voice' ? 'voice' : modeBadge === 'keyboard' ? 'keyboard' : '';
      tr.innerHTML = `
        <td class="lb-rank">${entry.rank}</td>
        <td class="lb-name">${escapeHtml(entry.name || 'Anonymous')}</td>
        <td class="lb-rating">${Math.round(entry.rating)}</td>
        <td class="lb-record">${wl}</td>
        <td><span class="lb-badge ${badgeClass}">${modeBadge || '—'}</span></td>
      `;
      body.appendChild(tr);
    }

    // Show viewer's own row if they're ranked but not in the top entries
    if (data.viewer && !data.viewer_in_entries) {
      const v = data.viewer;
      const vwl = `${v.wins}W-${v.losses}L` + (v.draws ? `-${v.draws}D` : '');
      const vBadge = v.input_mode || '';
      const vBadgeClass = vBadge === 'voice' ? 'voice' : vBadge === 'keyboard' ? 'keyboard' : '';
      viewerRow.innerHTML = `
        <span class="lb-rank">#${v.rank}</span>
        <span class="lb-name">${escapeHtml(v.name || 'You')}</span>
        <span class="lb-rating">${Math.round(v.rating)}</span>
        <span class="lb-record">${vwl}</span>
        <span class="lb-badge ${vBadgeClass}">${vBadge || '—'}</span>
      `;
      viewerRow.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('[leaderboard] Failed to load:', err);
    emptyEl.textContent = 'Failed to load leaderboard.';
    emptyEl.classList.remove('hidden');
  }
}

/** Escape HTML to prevent XSS in player names */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Leaderboard button on landing page
document.getElementById('btn-leaderboard').addEventListener('click', () => {
  showScreen('leaderboard');
  loadLeaderboard(lbCategory);
});

// Filter buttons
document.getElementById('lb-filters').addEventListener('click', e => {
  const btn = e.target.closest('.lb-filter');
  if (!btn) return;
  loadLeaderboard(btn.dataset.category);
});

// Back button
document.getElementById('btn-lb-back').addEventListener('click', () => showScreen('landing'));

// ─────────────────────────────────────────────
// Click handlers for mode pills (onboarding)
// ─────────────────────────────────────────────
document.querySelectorAll('.mode-pills').forEach(container => {
  const player = parseInt(container.dataset.player, 10);
  container.addEventListener('click', e => {
    const pill = e.target.closest('.mode-pill');
    if (!pill) return;
    const idx = parseInt(pill.dataset.mode, 10);
    // Skip restricted modes
    if (INPUT_MODES[idx].p1Only && player !== 1) return;
    if (INPUT_MODES[idx].p2Disabled && player === 2) return;
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
      do { p2ModeIdx = (p2ModeIdx - 1 + modeCount) % modeCount; } while (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled);
      updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
      saveModes();
      e.preventDefault();
    } else if (e.code === 'ArrowRight') {
      do { p2ModeIdx = (p2ModeIdx + 1) % modeCount; } while (INPUT_MODES[p2ModeIdx].p1Only || INPUT_MODES[p2ModeIdx].p2Disabled);
      updateModeSelection(2, p2ModeIdx, p2ProviderIdx);
      saveModes();
      e.preventDefault();
    } else if (e.code === 'Enter') {
      startFight();
    }
  } else if (state === 'fighting') {
    if (e.code === 'Enter' && game && game.roundOver && !peerConnection) {
      if (mmWaitingGame) {
        // Return to matchmaking searching screen
        if (game) { game.running = false; game = null; }
        cleanupAdapters();
        mmWaitingGame = false;
        showScreen('matchmaking');
      } else if (selectedCharacter) {
        // Character fight: Enter goes back to character select
        if (game) { game.running = false; game = null; }
        cleanupAdapters();
        p1Input = null; p2Input = null;
        showCharacterSelect();
      } else {
        // Classic single-player: Enter restarts
        showOnboarding();
      }
    }
  }

  // Escape goes back from any sub-screen
  if (e.code === 'Escape') {
    if (state === 'multiplayer') showScreen('landing');
    else if (state === 'joinRoom') showScreen('multiplayer');
    else if (state === 'roomLobby') { stopRoomPolling(); showScreen('multiplayer'); }
    else if (state === 'roomController') { stopRoomPolling(); showScreen('multiplayer'); }
    else if (state === 'matchmaking') {
      if (mmPlayerId) {
        fetch('/api/matchmaking/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerId: mmPlayerId }),
        }).catch(() => {});
        stopMatchmakingPoll();
        mmPlayerId = null;
      }
      showScreen('multiplayer');
    }
    else if (state === 'leaderboard') showScreen('landing');
    else if (state === 'matchResults') showLanding();
    else if (state === 'characterSelect') showScreen('landing');
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
  } else if (route.type === 'leaderboard') {
    showScreen('leaderboard');
    loadLeaderboard(lbCategory);
  } else if (route.type !== 'auth-callback') {
    showScreen('landing');
  }
});
