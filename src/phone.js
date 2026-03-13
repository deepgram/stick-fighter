// ─────────────────────────────────────────────
// PhoneAdapter — Twilio phone call → STT → game commands
//
// Player calls a Twilio number → audio streams to server →
// server bridges to Deepgram Flux STT → transcripts arrive via SSE →
// CommandAdapter parses them into game actions.
// ─────────────────────────────────────────────
import { CommandAdapter, COMMAND_VOCAB } from './input.js';

const VOCAB_KEYS = Object.keys(COMMAND_VOCAB).sort((a, b) => b.length - a.length);

export class PhoneAdapter {
  constructor(player) {
    this.player = player;
    this.command = new CommandAdapter();
    this.sessionId = null;
    this.eventSource = null;
    this.phoneNumber = null;
    this.ready = false;
    this._readyResolve = null;
    this._game = null;
    this._lastTranscript = '';
    this._executedText = '';
    this._turnFade = 0;
    this._callConnected = false;
  }

  async attach() {
    // 1. Allocate a phone number from the server
    const resp = await fetch('/api/phone/allocate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player: this.player }),
    });

    if (!resp.ok) {
      console.error(`[Phone P${this.player}] Allocation failed: ${resp.status}`);
      // Still mark as ready so game doesn't hang
      this.ready = true;
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
      return;
    }

    const { sessionId, phoneNumber } = await resp.json();
    this.sessionId = sessionId;
    this.phoneNumber = phoneNumber;
    this._updatePhoneDisplay();
    console.log(`[Phone P${this.player}] Allocated ${phoneNumber}`);

    // 2. Connect SSE for transcript events
    this.eventSource = new EventSource(`/api/phone/connect?session=${sessionId}`);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this._handleSSEMessage(data);
      } catch (e) {
        console.error(`[Phone P${this.player}] SSE parse error:`, e);
      }
    };

    this.eventSource.onerror = (e) => {
      console.error(`[Phone P${this.player}] SSE error`, e);
    };

    // Not ready yet — wait until the caller actually connects via Twilio
  }

  _handleSSEMessage(data) {
    if (data.type === 'connected') {
      console.log(`[Phone P${this.player}] SSE connected`);
    } else if (data.type === 'call_connected') {
      console.log(`[Phone P${this.player}] Call connected!`);
      this._callConnected = true;
      this._updatePhoneDisplay();
      if (!this.ready) {
        this.ready = true;
        if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; }
      }
    } else if (data.type === 'call_disconnected') {
      console.log(`[Phone P${this.player}] Call disconnected`);
      this._callConnected = false;
      this._updatePhoneDisplay();
    } else if (data.type === 'TurnInfo') {
      this._handleSTTMessage(data);
    }
  }

  _handleSTTMessage(msg) {
    const transcript = (msg.transcript || '').trim();
    const event = msg.event;

    if (event === 'Update' || event === 'StartOfTurn' || event === 'TurnResumed') {
      if (!transcript || transcript === this._lastTranscript) return;
      console.log(`[Phone P${this.player}] ${event}: "${transcript}"`);
      this._lastTranscript = transcript;

      // Only execute the NEW suffix to avoid re-triggering earlier actions
      const lower = transcript.toLowerCase();
      const prev = this._executedText;
      if (prev && lower.startsWith(prev)) {
        const suffix = lower.slice(prev.length).trim();
        if (suffix) this.command.execute(suffix);
      } else {
        this.command.execute(transcript);
      }
      this._executedText = lower;

      this._updateTranscriptDisplay(transcript);

    } else if (event === 'EndOfTurn' || event === 'EagerEndOfTurn') {
      console.log(`[Phone P${this.player}] ${event}: "${transcript}"`);
      if (transcript) {
        this._updateTranscriptDisplay(transcript);
        this._turnFade = 1.5;
      }
      this._lastTranscript = '';
      this._executedText = '';
    }
  }

  _updateTranscriptDisplay(text) {
    if (!this._game) return;

    const segments = [];
    let remaining = text.toLowerCase().trim();

    while (remaining.length > 0) {
      let found = false;
      for (const key of VOCAB_KEYS) {
        if (remaining.startsWith(key)) {
          for (const w of key.split(' ')) {
            segments.push({ text: w, matched: true });
          }
          remaining = remaining.slice(key.length).trim();
          found = true;
          break;
        }
      }
      if (!found) {
        const spaceIdx = remaining.indexOf(' ');
        const word = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);
        segments.push({ text: word, matched: false });
        remaining = spaceIdx === -1 ? '' : remaining.slice(spaceIdx + 1).trim();
      }
    }

    this._turnFade = 0;
    const key = this.player === 1 ? 'p1Transcript' : 'p2Transcript';
    this._game[key] = { segments, fade: 0 };
  }

  _updatePhoneDisplay() {
    if (!this._game) return;
    const key = this.player === 1 ? 'p1PhoneInfo' : 'p2PhoneInfo';
    this._game[key] = {
      number: this.phoneNumber,
      connected: this._callConnected,
    };
  }

  waitUntilReady() {
    if (this.ready) return Promise.resolve();
    return new Promise(resolve => { this._readyResolve = resolve; });
  }

  setGameRef(game) {
    this._game = game;
    this._updatePhoneDisplay();
  }

  async detach() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.sessionId) {
      try {
        await fetch('/api/phone/close', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: this.sessionId }),
        });
      } catch (e) {
        console.error(`[Phone P${this.player}] Close error:`, e);
      }
      this.sessionId = null;
    }
    this.phoneNumber = null;
    this.ready = false;
    this._callConnected = false;
    this._game = null;
  }

  setFacing(facing) {
    this.command.setFacing(facing);
  }

  update(dt) {
    this.command.update(dt);

    // Tick transcript fade
    if (this._turnFade > 0 && this._game) {
      this._turnFade -= dt;
      const key = this.player === 1 ? 'p1Transcript' : 'p2Transcript';
      if (this._game[key]) {
        this._game[key].fade = Math.max(0, this._turnFade / 1.5);
        if (this._turnFade <= 0) {
          this._game[key] = null;
        }
      }
    }
  }

  getActions() {
    return this.command.getActions();
  }

  getJustPressed() {
    return this.command.getJustPressed();
  }

  endFrame() {
    this.command.endFrame();
  }
}
