// ─────────────────────────────────────────────
// WebRTC Data Channel — peer input exchange
// ─────────────────────────────────────────────
// Each client establishes a WebRTC data channel with the other peer
// for low-latency input exchange. Both clients also send inputs to
// the server via WebSocket for authoritative validation.
//
// If WebRTC fails, the system falls back to server-only relay via
// the existing /ws/game/{code} WebSocket.

const RECONNECT_DELAY = 2000; // ms
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Manages a WebRTC peer connection + data channel for one multiplayer room,
 * along with the fallback WebSocket to the game server.
 */
export class PeerConnection {
  constructor(roomCode, playerId, playerNum) {
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.playerNum = playerNum;

    // WebRTC
    this.pc = null;
    this.dataChannel = null;
    this.iceServers = [];

    // WebSocket (server relay / authoritative state)
    this.ws = null;

    // SSE (signaling)
    this.signalSource = null;

    // Callbacks
    this._onRemoteInput = null;
    this._onServerState = null;
    this._onConnectionChange = null;

    // State
    this.connected = false;     // data channel is open
    this.wsConnected = false;   // game WebSocket is open
    this.fallbackMode = false;  // true = WebRTC failed, WS-only mode
    this._reconnectAttempts = 0;
    this._closed = false;
  }

  /** Register callback for remote peer inputs (via data channel) */
  onRemoteInput(cb) { this._onRemoteInput = cb; }

  /** Register callback for authoritative server state (via WebSocket) */
  onServerState(cb) { this._onServerState = cb; }

  /** Register callback for connection state changes */
  onConnectionChange(cb) { this._onConnectionChange = cb; }

  /**
   * Establish WebSocket + WebRTC connections.
   * WebSocket connects first (always needed). Then signaling starts
   * and WebRTC is attempted. If WebRTC fails, falls back to WS-only.
   */
  async connect() {
    this._connectWebSocket();

    try {
      await this._startSignaling();
    } catch (err) {
      console.warn('[webrtc] Signaling failed, falling back to server relay:', err);
      this._enterFallback();
    }
  }

  /**
   * Send local player inputs to both the peer (data channel) and the
   * server (WebSocket). The peer gets them for local prediction, the
   * server uses them for authoritative validation.
   */
  sendInput(actions, justPressed) {
    const msg = JSON.stringify({
      type: 'input',
      actions: Array.from(actions),
      just_pressed: Array.from(justPressed),
    });

    // Send to peer via data channel (if connected)
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(msg);
      } catch (err) {
        console.warn('[webrtc] Data channel send error:', err);
      }
    }

    // Always send to server via WebSocket for authoritative validation
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    }
  }

  /** Tear down all connections and clean up. */
  close() {
    this._closed = true;

    if (this.signalSource) {
      this.signalSource.close();
      this.signalSource = null;
    }
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.connected = false;
    this.wsConnected = false;
  }

  // ── WebSocket (server relay) ──────────────────

  _connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/game/${this.roomCode}?player=${this.playerNum}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log('[webrtc] Game WebSocket connected');
      this.wsConnected = true;
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (this._onServerState) this._onServerState(msg);
      } catch (err) {
        console.warn('[webrtc] WS message parse error:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('[webrtc] Game WebSocket disconnected');
      this.wsConnected = false;
    };

    this.ws.onerror = (err) => {
      console.warn('[webrtc] Game WebSocket error:', err);
    };
  }

  // ── WebRTC Signaling ──────────────────────────

  async _startSignaling() {
    return new Promise((resolve, reject) => {
      const url = `/api/room/signal/listen?room=${encodeURIComponent(this.roomCode)}&player_id=${encodeURIComponent(this.playerId)}`;

      this.signalSource = new EventSource(url);
      let resolved = false;

      this.signalSource.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            this.iceServers = data.iceServers || [];
            this._createPeerConnection();

            // P1 creates the offer; P2 waits for it
            if (this.playerNum === 1) {
              await this._createOffer();
            }
            resolved = true;
            resolve();
          } else if (data.type === 'offer') {
            await this._handleOffer(data);
          } else if (data.type === 'answer') {
            await this._handleAnswer(data);
          } else if (data.candidate !== undefined) {
            await this._handleIceCandidate(data);
          }
        } catch (err) {
          console.warn('[webrtc] Signal processing error:', err);
        }
      };

      this.signalSource.onerror = () => {
        console.warn('[webrtc] Signal SSE error');
        if (!resolved) {
          reject(new Error('Signaling SSE failed'));
        }
      };
    });
  }

  // ── RTCPeerConnection ─────────────────────────

  _createPeerConnection() {
    this.pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // Send ICE candidates to peer via signaling
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this._sendSignal({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log('[webrtc] Connection state:', state);
      if (state === 'failed' || state === 'disconnected') {
        this._handleDisconnect();
      }
    };

    // P1 creates the data channel; P2 receives it via ondatachannel
    if (this.playerNum === 1) {
      this.dataChannel = this.pc.createDataChannel('game-inputs', {
        ordered: false,       // low latency over ordering
        maxRetransmits: 0,    // unreliable = faster for real-time inputs
      });
      this._setupDataChannel(this.dataChannel);
    } else {
      this.pc.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      };
    }
  }

  _setupDataChannel(channel) {
    channel.onopen = () => {
      console.log('[webrtc] Data channel open');
      this.connected = true;
      this._reconnectAttempts = 0;
      if (this._onConnectionChange) {
        this._onConnectionChange({ connected: true, fallback: false });
      }
    };

    channel.onclose = () => {
      console.log('[webrtc] Data channel closed');
      this.connected = false;
      if (!this._closed) {
        this._handleDisconnect();
      }
    };

    channel.onerror = (err) => {
      console.warn('[webrtc] Data channel error:', err);
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'input' && this._onRemoteInput) {
          this._onRemoteInput(msg);
        }
      } catch (err) {
        console.warn('[webrtc] Data channel message parse error:', err);
      }
    };
  }

  async _createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this._sendSignal({
      type: 'offer',
      sdp: offer.sdp,
    });
  }

  async _handleOffer(data) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription({
      type: 'offer',
      sdp: data.sdp,
    }));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this._sendSignal({
      type: 'answer',
      sdp: answer.sdp,
    });
  }

  async _handleAnswer(data) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: data.sdp,
    }));
  }

  async _handleIceCandidate(data) {
    if (!this.pc) return;
    try {
      await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (err) {
      console.warn('[webrtc] Failed to add ICE candidate:', err);
    }
  }

  async _sendSignal(signal) {
    try {
      await fetch('/api/room/signal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room: this.roomCode,
          playerId: this.playerId,
          signal,
        }),
      });
    } catch (err) {
      console.warn('[webrtc] Failed to send signal:', err);
    }
  }

  // ── Reconnection & Fallback ───────────────────

  _handleDisconnect() {
    if (this._closed || this.fallbackMode) return;

    this.connected = false;
    this._reconnectAttempts++;

    if (this._reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
      console.log(`[webrtc] Reconnect attempt ${this._reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}...`);
      setTimeout(() => this._attemptReconnect(), RECONNECT_DELAY);
    } else {
      console.log('[webrtc] Max reconnect attempts reached, entering fallback mode');
      this._enterFallback();
    }
  }

  async _attemptReconnect() {
    if (this._closed || this.connected) return;

    // Clean up old peer connection
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.dataChannel = null;

    try {
      this._createPeerConnection();
      if (this.playerNum === 1) {
        await this._createOffer();
      }
    } catch (err) {
      console.warn('[webrtc] Reconnect failed:', err);
      this._handleDisconnect();
    }
  }

  _enterFallback() {
    this.fallbackMode = true;
    this.connected = false;

    // Clean up WebRTC resources
    if (this.signalSource) {
      this.signalSource.close();
      this.signalSource = null;
    }
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }

    console.log('[webrtc] Fallback mode: using server relay only');
    if (this._onConnectionChange) {
      this._onConnectionChange({ connected: false, fallback: true });
    }
  }
}


// ─────────────────────────────────────────────
// RemoteInputAdapter — standard InputAdapter that
// receives inputs from a remote peer via data channel
// ─────────────────────────────────────────────

export class RemoteInputAdapter {
  constructor() {
    this.held = new Set();
    this.justPressed = new Set();
  }

  attach() {}
  detach() {}

  /** Called when a remote input message arrives from the peer. */
  receiveInput(msg) {
    this.held = new Set(msg.actions || []);
    for (const action of (msg.just_pressed || [])) {
      this.justPressed.add(action);
    }
  }

  getActions() { return this.held; }
  getJustPressed() { return this.justPressed; }
  endFrame() { this.justPressed.clear(); }
}
