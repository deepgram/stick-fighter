// ─────────────────────────────────────────────
// VoiceAdapter — Split STT / LLM / TTS
//
// mic audio → WS → Deepgram STT (Flux) → interim transcripts → action detection
//                                       → final transcripts  → Anthropic LLM → Deepgram TTS → speaker
//
// Actions are detected from interim transcripts for minimum latency.
// The LLM provides a fighter personality that reacts via TTS.
// ─────────────────────────────────────────────
import { CommandAdapter, COMMAND_VOCAB } from './input.js';

// Sorted vocab keys longest-first for greedy matching (same order as CommandAdapter)
const VOCAB_KEYS = Object.keys(COMMAND_VOCAB).sort((a, b) => b.length - a.length);

// Fighter personality prompt sent to Anthropic
const SYSTEM_PROMPT = `You are a stick fighter character in a 2D fighting game. Your player controls you with voice commands.

PERSONALITY:
- You're a scrappy, competitive fighter with attitude
- You get annoyed when you take damage — blame the player for not blocking
- You celebrate when landing hits
- You're sarcastic but loyal to your player
- Keep responses VERY short (1-5 words max) when you DO speak
- React emotionally and quickly — this is real-time combat

BEHAVIOUR:
- The player shouts combat commands like "punch", "kick", "jump", "forward", etc. These are handled automatically by the game — you do NOT need to repeat or confirm them.
- When the player gives combat commands, either stay silent or give very brief trash-talk/hype (like "let's go!" or "yeah!")
- If the player's message is ONLY combat commands, respond with just "" (empty) — say nothing.
- When you receive context about being hit, react with brief frustration ("ugh!", "come on!", "block next time!")
- When context says you landed a hit, react with excitement ("yes!", "gotcha!", "take that!")
- For non-combat conversation, respond naturally but keep it short — you're mid-fight`;

// Words that indicate combat commands (used to decide if LLM should respond)
const ACTION_WORDS = new Set([
  'forward', 'forwards', 'back', 'backward', 'backwards',
  'crouch', 'duck', 'jump', 'somersault', 'flip',
  'dash', 'punch', 'jab', 'kick', 'roundhouse',
  'fierce', 'light', 'medium', 'heavy', 'hard', 'strong', 'short',
]);

// Filler words that STT picks up — ignore these, don't treat as conversation
const IGNORE_WORDS = new Set([
  'the', 'a', 'an', 'go', 'do', 'it', 'now', 'and', 'then',
  'um', 'uh', 'ah', 'oh', 'like', 'just', 'yeah', 'yes', 'no',
  'ok', 'okay', 'come', 'on', 'let', 'lets', "let's", 'get',
  'him', 'her', 'them', 'that', 'this', 'right', 'left',
]);

export class VoiceAdapter {
  constructor(player) {
    this.player = player;
    this.command = new CommandAdapter();
    this.sttWs = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.processor = null;
    this.playbackCtx = null;
    this._nextPlayTime = 0;
    this.ready = false;
    this._game = null;
    this._readyResolve = null;
    this._audioBuffer = [];
    this._messages = [];       // conversation history for LLM
    this._llmBusy = false;     // prevent overlapping LLM calls
    this._lastTranscript = ''; // last full transcript (for dedup)
    this._executedText = '';   // text already sent to command adapter
    this._turnFade = 0;        // fade timer after turn ends
  }

  async attach() {
    this._audioBuffer = [];

    // 1. Request mic FIRST (needs user gesture context)
    console.log(`[Voice P${this.player}] Requesting microphone...`);
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    console.log(`[Voice P${this.player}] Microphone granted, starting capture`);

    // 2. Start capturing audio immediately (buffered until STT ready)
    this.audioContext = new AudioContext({ sampleRate: 16000 });
    const source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = float32ToInt16(float32);
      if (this.ready && this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
        this.sttWs.send(int16.buffer);
      } else if (this._audioBuffer) {
        this._audioBuffer.push(int16.buffer);
      }
      // If not ready and no buffer, audio is silently dropped (post-flush, WS closed)
    };
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    // 3. Set up TTS playback context
    this.playbackCtx = new AudioContext({ sampleRate: 24000 });

    // 4. Connect STT WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/stt`;
    this.sttWs = new WebSocket(wsUrl);
    this.sttWs.binaryType = 'arraybuffer';

    this.sttWs.onopen = () => {
      console.log(`[Voice P${this.player}] STT WebSocket connected`);
      this.ready = true;
      this._flushAudioBuffer();
    };

    this.sttWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this._handleSTTMessage(msg);
      } catch (e) {
        console.error(`[Voice P${this.player}] STT parse error:`, e);
      }
    };

    this.sttWs.onerror = (e) => {
      console.error(`[Voice P${this.player}] STT WebSocket error`, e);
    };

    this.sttWs.onclose = (e) => {
      console.log(`[Voice P${this.player}] STT WebSocket closed: code=${e.code}`);
      this.ready = false;
    };
  }

  _handleSTTMessage(msg) {
    // Deepgram Flux v2 TurnInfo events
    if (msg.type !== 'TurnInfo') return;

    const transcript = (msg.transcript || '').trim();
    const event = msg.event;

    if (event === 'Update' || event === 'StartOfTurn' || event === 'TurnResumed') {
      if (!transcript || transcript === this._lastTranscript) return;
      console.log(`[Voice P${this.player}] ${event}: "${transcript}"`);
      this._lastTranscript = transcript;

      // Only execute the NEW suffix to avoid re-triggering earlier actions
      const lower = transcript.toLowerCase();
      const prev = this._executedText;
      if (prev && lower.startsWith(prev)) {
        const suffix = lower.slice(prev.length).trim();
        if (suffix) this.command.execute(suffix);
      } else {
        // Transcript was revised — execute the whole thing
        this.command.execute(transcript);
      }
      this._executedText = lower;

      // Always show the full growing transcript
      this._updateTranscriptDisplay(transcript);

    } else if (event === 'EndOfTurn' || event === 'EagerEndOfTurn') {
      // Turn complete — don't re-execute, just evaluate for personality LLM
      console.log(`[Voice P${this.player}] ${event}: "${transcript}"`);
      if (transcript) {
        this._updateTranscriptDisplay(transcript);
        this._maybeSendToLLM(transcript);
        this._turnFade = 1.5;
      }
      this._lastTranscript = '';
      this._executedText = '';
    }
  }

  /** Update the live transcript display on the game HUD */
  _updateTranscriptDisplay(text) {
    if (!this._game) return;

    // Build word segments with matched/unmatched flags using greedy vocab matching
    const segments = [];
    let remaining = text.toLowerCase().trim();

    while (remaining.length > 0) {
      let found = false;
      for (const key of VOCAB_KEYS) {
        if (remaining.startsWith(key)) {
          // Multi-word command — split into individual words, all marked matched
          for (const w of key.split(' ')) {
            segments.push({ text: w, matched: true });
          }
          remaining = remaining.slice(key.length).trim();
          found = true;
          break;
        }
      }
      if (!found) {
        // Take next word as unmatched
        const spaceIdx = remaining.indexOf(' ');
        const word = spaceIdx === -1 ? remaining : remaining.slice(0, spaceIdx);
        segments.push({ text: word, matched: false });
        remaining = spaceIdx === -1 ? '' : remaining.slice(spaceIdx + 1).trim();
      }
    }

    this._turnFade = 0; // reset fade while actively speaking
    const key = this.player === 1 ? 'p1Transcript' : 'p2Transcript';
    this._game[key] = { segments, fade: 0 };
  }

  /** Only send to LLM if the turn is clearly conversational */
  _maybeSendToLLM(text) {
    const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return;

    // Count words that are NOT action words and NOT filler
    const unknownWords = words.filter(w => !ACTION_WORDS.has(w) && !IGNORE_WORDS.has(w));

    // Only send to LLM if majority of meaningful words are non-action
    if (unknownWords.length < 2 || unknownWords.length / words.length < 0.5) return;

    this._sendToLLM(text);
  }

  /** Send text to Anthropic LLM via server, then TTS the response */
  async _sendToLLM(text) {
    if (this._llmBusy) return;
    this._llmBusy = true;

    // Add user message to history
    this._messages.push({ role: 'user', content: text });
    // Keep history short (last 10 messages)
    if (this._messages.length > 10) {
      this._messages = this._messages.slice(-10);
    }

    try {
      const resp = await fetch('/api/voice/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: SYSTEM_PROMPT,
          messages: this._messages,
        }),
      });

      if (!resp.ok) {
        console.error(`[Voice P${this.player}] LLM error: ${resp.status}`);
        return;
      }

      const { text: reply } = await resp.json();
      if (reply && reply.trim()) {
        console.log(`[Voice P${this.player}] Agent: "${reply}"`);
        this._messages.push({ role: 'assistant', content: reply });
        await this._speakTTS(reply);
      }
    } catch (e) {
      console.error(`[Voice P${this.player}] LLM fetch error:`, e);
    } finally {
      this._llmBusy = false;
    }
  }

  /** Send text to Deepgram TTS via server and play the audio */
  async _speakTTS(text) {
    try {
      const resp = await fetch('/api/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });

      if (!resp.ok) {
        console.error(`[Voice P${this.player}] TTS error: ${resp.status}`);
        return;
      }

      const arrayBuffer = await resp.arrayBuffer();
      this._playAudio(arrayBuffer);
    } catch (e) {
      console.error(`[Voice P${this.player}] TTS fetch error:`, e);
    }
  }

  /** Play linear16 PCM audio at 24kHz — chunks scheduled back-to-back */
  _playAudio(arrayBuffer) {
    if (!this.playbackCtx) return;

    const int16 = new Int16Array(arrayBuffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.playbackCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const now = this.playbackCtx.currentTime;
    if (this._nextPlayTime < now) {
      this._nextPlayTime = now;
    }

    const source = this.playbackCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.playbackCtx.destination);
    source.start(this._nextPlayTime);
    this._nextPlayTime += buffer.duration;
  }

  /** Returns a promise that resolves when mic + STT are ready */
  waitUntilReady() {
    if (this.ready) return Promise.resolve();
    return new Promise(resolve => { this._readyResolve = resolve; });
  }

  /** Send buffered audio chunks, keeping only the last ~2 seconds */
  _flushAudioBuffer() {
    if (!this._audioBuffer || !this.sttWs) return;

    const maxChunks = 8;
    const chunks = this._audioBuffer.length > maxChunks
      ? this._audioBuffer.slice(-maxChunks)
      : this._audioBuffer;

    console.log(`[Voice P${this.player}] Flushing ${chunks.length} buffered chunks`);
    for (const chunk of chunks) {
      this.sttWs.send(chunk);
    }
    this._audioBuffer = null;

    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
    }
  }

  /** Set game reference for context injection */
  setGameRef(game) {
    this._game = game;
  }

  /** Inject fight context — sent to LLM for personality reactions */
  injectContext(context) {
    if (!this.ready) return;
    this._sendToLLM(`[GAME EVENT] ${context}`);
  }

  async detach() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
    if (this.playbackCtx) {
      await this.playbackCtx.close();
      this.playbackCtx = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.sttWs) {
      this.sttWs.close();
      this.sttWs = null;
    }
    this.ready = false;
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
        this._game[key].fade = Math.max(0, this._turnFade / 1.5); // normalize to 0-1
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

/** Convert Float32 audio samples to Int16 PCM */
function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
