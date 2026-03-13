import { describe, test, expect, beforeEach, jest } from '@jest/globals';

// ── Mock browser globals before importing module ──────────

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sent = [];
    // Auto-trigger onopen synchronously via microtask (avoids async leaks)
    Promise.resolve().then(() => this.onopen?.());
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(); }
}
globalThis.WebSocket = MockWebSocket;

// Mock EventSource
class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    MockEventSource._last = this;
  }
  close() { this.closed = true; }
  // Test helper: simulate a message
  _emit(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
MockEventSource._last = null;
globalThis.EventSource = MockEventSource;

// Mock RTCPeerConnection
class MockRTCPeerConnection {
  constructor(config) {
    this.config = config;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    this.ondatachannel = null;
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this._channels = [];
    MockRTCPeerConnection._last = this;
  }
  createDataChannel(label, options) {
    const ch = new MockDataChannel(label, options);
    this._channels.push(ch);
    return ch;
  }
  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' }; }
  async createAnswer() { return { type: 'answer', sdp: 'mock-answer-sdp' }; }
  async setLocalDescription(desc) { this.localDescription = desc; }
  async setRemoteDescription(desc) { this.remoteDescription = desc; }
  async addIceCandidate(candidate) { this._lastCandidate = candidate; }
  close() { this.connectionState = 'closed'; }
}
MockRTCPeerConnection._last = null;
globalThis.RTCPeerConnection = MockRTCPeerConnection;

// Mock RTCSessionDescription
globalThis.RTCSessionDescription = class {
  constructor(init) { Object.assign(this, init); }
};

// Mock RTCIceCandidate
globalThis.RTCIceCandidate = class {
  constructor(init) { Object.assign(this, init); }
};

// Mock DataChannel
class MockDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'connecting';
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    this.sent = [];
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = 'closed'; this.onclose?.(); }
  _open() { this.readyState = 'open'; this.onopen?.(); }
}

// Mock location and fetch
globalThis.location = { protocol: 'http:', host: 'localhost:3000' };
globalThis.fetch = jest.fn(() => Promise.resolve({ ok: true }));

// ── Import module ──────────────────────────────

const { PeerConnection, RemoteInputAdapter } = await import('../src/webrtc.js');


// ─────────────────────────────────────────────
// RemoteInputAdapter tests
// ─────────────────────────────────────────────

describe('RemoteInputAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new RemoteInputAdapter();
  });

  test('starts with empty actions and justPressed', () => {
    expect(adapter.getActions().size).toBe(0);
    expect(adapter.getJustPressed().size).toBe(0);
  });

  test('receiveInput updates held actions', () => {
    adapter.receiveInput({ actions: ['left', 'down'], just_pressed: [] });
    expect([...adapter.getActions()]).toEqual(['left', 'down']);
  });

  test('receiveInput replaces previous held actions', () => {
    adapter.receiveInput({ actions: ['left'], just_pressed: [] });
    adapter.receiveInput({ actions: ['right'], just_pressed: [] });
    expect([...adapter.getActions()]).toEqual(['right']);
  });

  test('receiveInput accumulates justPressed until endFrame', () => {
    adapter.receiveInput({ actions: [], just_pressed: ['lightPunch'] });
    adapter.receiveInput({ actions: [], just_pressed: ['heavyKick'] });
    const pressed = adapter.getJustPressed();
    expect(pressed.has('lightPunch')).toBe(true);
    expect(pressed.has('heavyKick')).toBe(true);
  });

  test('endFrame clears justPressed but not held', () => {
    adapter.receiveInput({ actions: ['left'], just_pressed: ['jump'] });
    adapter.endFrame();
    expect(adapter.getJustPressed().size).toBe(0);
    expect([...adapter.getActions()]).toEqual(['left']);
  });

  test('attach and detach are no-ops', () => {
    expect(() => adapter.attach()).not.toThrow();
    expect(() => adapter.detach()).not.toThrow();
  });

  test('handles missing fields gracefully', () => {
    adapter.receiveInput({});
    expect(adapter.getActions().size).toBe(0);
    expect(adapter.getJustPressed().size).toBe(0);
  });
});


// ─────────────────────────────────────────────
// PeerConnection tests
// ─────────────────────────────────────────────

describe('PeerConnection', () => {
  let pc;

  beforeEach(() => {
    jest.clearAllMocks();
    MockEventSource._last = null;
    MockRTCPeerConnection._last = null;
    pc = new PeerConnection('red-tiger-paw', 'player-uuid-1', 1);
  });

  describe('constructor', () => {
    test('stores room code, player ID, and player number', () => {
      expect(pc.roomCode).toBe('red-tiger-paw');
      expect(pc.playerId).toBe('player-uuid-1');
      expect(pc.playerNum).toBe(1);
    });

    test('starts disconnected and not in fallback', () => {
      expect(pc.connected).toBe(false);
      expect(pc.wsConnected).toBe(false);
      expect(pc.fallbackMode).toBe(false);
    });
  });

  describe('WebSocket connection', () => {
    test('connect creates WebSocket to game endpoint', async () => {
      // Don't await — signaling will hang. Just call it.
      pc._connectWebSocket();
      expect(pc.ws).not.toBeNull();
      expect(pc.ws.url).toBe('ws://localhost:3000/ws/game/red-tiger-paw?player=1');
    });

    test('WebSocket onopen sets wsConnected', () => {
      pc._connectWebSocket();
      pc.ws.onopen();
      expect(pc.wsConnected).toBe(true);
    });

    test('WebSocket onclose clears wsConnected', () => {
      pc._connectWebSocket();
      pc.ws.onopen();
      pc.ws.onclose();
      expect(pc.wsConnected).toBe(false);
    });

    test('WebSocket messages forwarded to onServerState callback', () => {
      const cb = jest.fn();
      pc.onServerState(cb);
      pc._connectWebSocket();
      pc.ws.onmessage({ data: JSON.stringify({ type: 'state', tick: 1 }) });
      expect(cb).toHaveBeenCalledWith({ type: 'state', tick: 1 });
    });
  });

  describe('sendInput', () => {
    test('sends to both data channel and WebSocket', () => {
      pc._connectWebSocket();
      pc.ws.readyState = WebSocket.OPEN;
      pc.dataChannel = new MockDataChannel('test');
      pc.dataChannel._open();

      pc.sendInput(new Set(['left', 'down']), new Set(['lightPunch']));

      const expected = JSON.stringify({
        type: 'input',
        actions: ['left', 'down'],
        just_pressed: ['lightPunch'],
      });
      expect(pc.dataChannel.sent).toHaveLength(1);
      expect(pc.dataChannel.sent[0]).toBe(expected);
      expect(pc.ws.sent).toHaveLength(1);
      expect(pc.ws.sent[0]).toBe(expected);
    });

    test('sends to WS only when data channel not open', () => {
      pc._connectWebSocket();
      pc.ws.readyState = WebSocket.OPEN;

      pc.sendInput(new Set(['up']), new Set());

      expect(pc.ws.sent).toHaveLength(1);
    });

    test('handles WS closed gracefully', () => {
      pc.sendInput(new Set(), new Set(['jump']));
      // No error thrown
    });
  });

  describe('signaling flow (P1 = offerer)', () => {
    test('P1 creates offer on SSE connected event', async () => {
      const signalPromise = pc._startSignaling();
      const sse = MockEventSource._last;

      // Simulate SSE connected event
      sse._emit({ type: 'connected', player: 1, iceServers: [{ urls: 'stun:test' }] });
      await signalPromise;

      // Should have created RTCPeerConnection
      expect(pc.pc).not.toBeNull();
      expect(pc.iceServers).toEqual([{ urls: 'stun:test' }]);

      // P1 should have sent an offer via fetch
      expect(fetch).toHaveBeenCalledWith('/api/room/signal', expect.objectContaining({
        method: 'POST',
      }));
      const body = JSON.parse(fetch.mock.calls[0][1].body);
      expect(body.signal.type).toBe('offer');
      expect(body.signal.sdp).toBe('mock-offer-sdp');
    });

    test('P1 creates data channel (not P2)', async () => {
      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      const rtc = MockRTCPeerConnection._last;
      expect(rtc._channels).toHaveLength(1);
      expect(rtc._channels[0].label).toBe('game-inputs');
    });
  });

  describe('signaling flow (P2 = answerer)', () => {
    let p2;

    beforeEach(() => {
      p2 = new PeerConnection('red-tiger-paw', 'player-uuid-2', 2);
    });

    test('P2 does not create offer on connect', async () => {
      const signalPromise = p2._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 2, iceServers: [] });
      await signalPromise;

      // P2 should NOT have called fetch (no offer)
      expect(fetch).not.toHaveBeenCalled();
    });

    test('P2 receives offer and sends answer', async () => {
      const signalPromise = p2._startSignaling();
      const sse = MockEventSource._last;
      sse._emit({ type: 'connected', player: 2, iceServers: [] });
      await signalPromise;

      // Simulate receiving an offer
      await sse.onmessage({ data: JSON.stringify({ type: 'offer', sdp: 'remote-offer-sdp' }) });

      // Should have set remote description
      expect(p2.pc.remoteDescription.sdp).toBe('remote-offer-sdp');

      // Should have sent an answer
      const answerCall = fetch.mock.calls.find(c => {
        const body = JSON.parse(c[1].body);
        return body.signal.type === 'answer';
      });
      expect(answerCall).toBeTruthy();
    });

    test('P2 gets data channel via ondatachannel', async () => {
      const signalPromise = p2._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 2, iceServers: [] });
      await signalPromise;

      // Simulate P1's data channel reaching P2
      const channel = new MockDataChannel('game-inputs');
      p2.pc.ondatachannel({ channel });

      expect(p2.dataChannel).toBe(channel);
    });
  });

  describe('ICE candidate handling', () => {
    test('sends ICE candidates to peer via signaling', async () => {
      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      // Simulate local ICE candidate
      const candidate = { candidate: 'candidate:123', sdpMid: '0', sdpMLineIndex: 0 };
      pc.pc.onicecandidate({ candidate: { toJSON: () => candidate } });

      const iceCall = fetch.mock.calls.find(c => {
        const body = JSON.parse(c[1].body);
        return body.signal.type === 'ice-candidate';
      });
      expect(iceCall).toBeTruthy();
    });

    test('handles received ICE candidate', async () => {
      const signalPromise = pc._startSignaling();
      const sse = MockEventSource._last;
      sse._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      // Simulate receiving ICE candidate from peer
      await sse.onmessage({ data: JSON.stringify({
        candidate: { candidate: 'remote:456' }
      })});

      expect(pc.pc._lastCandidate).toBeTruthy();
    });
  });

  describe('data channel events', () => {
    test('data channel open sets connected and triggers callback', async () => {
      const changeCb = jest.fn();
      pc.onConnectionChange(changeCb);

      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      // Open the data channel
      const channel = MockRTCPeerConnection._last._channels[0];
      channel._open();

      expect(pc.connected).toBe(true);
      expect(changeCb).toHaveBeenCalledWith({ connected: true, fallback: false });
    });

    test('data channel receives remote inputs', async () => {
      const inputCb = jest.fn();
      pc.onRemoteInput(inputCb);

      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      const channel = MockRTCPeerConnection._last._channels[0];
      channel._open();

      // Simulate receiving input from peer
      const inputMsg = { type: 'input', actions: ['right'], just_pressed: ['heavyPunch'] };
      channel.onmessage({ data: JSON.stringify(inputMsg) });

      expect(inputCb).toHaveBeenCalledWith(inputMsg);
    });
  });

  describe('reconnection', () => {
    test('disconnect triggers reconnect attempt', async () => {
      jest.useFakeTimers();

      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      // Simulate disconnect
      pc.pc.connectionState = 'disconnected';
      pc.pc.onconnectionstatechange();

      expect(pc._reconnectAttempts).toBe(1);

      jest.useRealTimers();
    });

    test('enters fallback after max reconnect attempts', async () => {
      const changeCb = jest.fn();
      pc.onConnectionChange(changeCb);

      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      // Exhaust reconnect attempts
      pc._reconnectAttempts = 3;
      pc._handleDisconnect();

      expect(pc.fallbackMode).toBe(true);
      expect(changeCb).toHaveBeenCalledWith({ connected: false, fallback: true });
    });
  });

  describe('fallback mode', () => {
    test('cleans up WebRTC resources on fallback', async () => {
      const signalPromise = pc._startSignaling();
      const sse = MockEventSource._last;
      sse._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      pc._enterFallback();

      expect(pc.pc).toBeNull();
      expect(pc.dataChannel).toBeNull();
      expect(pc.signalSource).toBeNull();
      expect(pc.fallbackMode).toBe(true);
      expect(sse.closed).toBe(true);
    });

    test('sendInput still works via WS in fallback mode', () => {
      pc._connectWebSocket();
      pc.ws.readyState = WebSocket.OPEN;
      pc._enterFallback();

      pc.sendInput(new Set(['left']), new Set());
      expect(pc.ws.sent).toHaveLength(1);
    });
  });

  describe('close', () => {
    test('cleans up all resources', async () => {
      pc._connectWebSocket();
      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      pc.close();

      expect(pc.pc).toBeNull();
      expect(pc.dataChannel).toBeNull();
      expect(pc.ws).toBeNull();
      expect(pc.signalSource).toBeNull();
      expect(pc.connected).toBe(false);
      expect(pc.wsConnected).toBe(false);
      expect(pc._closed).toBe(true);
    });

    test('does not reconnect after close', async () => {
      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      pc.close();

      // Try to trigger reconnect
      pc._handleDisconnect();
      expect(pc._reconnectAttempts).toBe(0); // should not increment
    });
  });

  describe('data channel configuration', () => {
    test('uses unordered unreliable channel for low latency', async () => {
      const signalPromise = pc._startSignaling();
      MockEventSource._last._emit({ type: 'connected', player: 1, iceServers: [] });
      await signalPromise;

      const channel = MockRTCPeerConnection._last._channels[0];
      expect(channel.options.ordered).toBe(false);
      expect(channel.options.maxRetransmits).toBe(0);
    });
  });
});
