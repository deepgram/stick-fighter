// ─────────────────────────────────────────────
// SSE/BiDi session client
// Connects to the backend via SSE (server→client)
// and POST requests (client→server)
// ─────────────────────────────────────────────

export class Session {
  constructor(player, mode) {
    this.player = player;
    this.mode = mode;   // 'voice' | 'llm'
    this.sessionId = null;
    this.eventSource = null;
    this.listeners = new Map(); // type → [callback]
    this.connected = false;
  }

  /** Open the SSE connection to the backend */
  connect() {
    return new Promise((resolve, reject) => {
      const url = `/api/session/connect?mode=${this.mode}&player=${this.player}`;
      this.eventSource = new EventSource(url);

      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'connected') {
            this.sessionId = data.sessionId;
            this.connected = true;
            resolve(this);
          }

          // Dispatch to listeners
          const callbacks = this.listeners.get(data.type);
          if (callbacks) {
            for (const cb of callbacks) cb(data);
          }

          // Also fire 'message' for all events
          const allCallbacks = this.listeners.get('*');
          if (allCallbacks) {
            for (const cb of allCallbacks) cb(data);
          }
        } catch (e) {
          console.error('[Session] Parse error:', e);
        }
      };

      this.eventSource.onerror = (e) => {
        if (!this.connected) {
          reject(new Error('SSE connection failed'));
        }
        console.error('[Session] SSE error');
      };
    });
  }

  /** Register a listener for a specific event type (or '*' for all) */
  on(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, []);
    }
    this.listeners.get(type).push(callback);
    return this;
  }

  /** Send data to the backend (BiDi: client→server) */
  async send(data) {
    if (!this.sessionId) throw new Error('Not connected');

    const isAudio = data instanceof ArrayBuffer || data instanceof Uint8Array;

    await fetch(`/api/session/send?session=${this.sessionId}`, {
      method: 'POST',
      headers: isAudio ? {} : { 'Content-Type': 'application/json' },
      body: isAudio ? data : JSON.stringify(data),
    });
  }

  /** Close the session */
  async close() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sessionId) {
      await fetch(`/api/session/close?session=${this.sessionId}`, { method: 'POST' }).catch(() => {});
      this.sessionId = null;
    }
    this.connected = false;
  }
}
