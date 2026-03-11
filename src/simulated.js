// ─────────────────────────────────────────────
// SimulatedAdapter — random commands via SSE
// (Lightweight AI opponent without real LLM calls)
// ─────────────────────────────────────────────
import { CommandAdapter } from './input.js';
import { Session } from './session.js';

const POLL_INTERVAL = 800; // ms between queries

export class SimulatedAdapter {
  constructor(player) {
    this.player = player;
    this.command = new CommandAdapter();
    this.session = null;
    this.game = null;
    this._pollTimer = null;
  }

  /** Set game reference for reading state */
  setGameRef(game) {
    this.game = game;
  }

  async attach() {
    this.session = new Session(this.player, 'llm');

    this.session.on('command', (data) => {
      if (data.command) {
        console.log(`[Sim P${this.player}] "${data.command}"`);
        this.command.execute(data.command);
      }
    });

    await this.session.connect();

    // Start polling game state
    this._pollTimer = setInterval(() => this._sendGameState(), POLL_INTERVAL);
  }

  async detach() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this.session) {
      await this.session.close();
      this.session = null;
    }
    this.game = null;
  }

  _sendGameState() {
    if (!this.session?.connected || !this.game || this.game.roundOver) return;

    const fighter = this.player === 1 ? this.game.p1 : this.game.p2;
    const opponent = this.player === 1 ? this.game.p2 : this.game.p1;

    const state = {
      me: {
        x: Math.round(fighter.x),
        y: Math.round(fighter.y),
        health: fighter.health,
        state: fighter.state,
        facing: fighter.facing,
      },
      opponent: {
        x: Math.round(opponent.x),
        y: Math.round(opponent.y),
        health: opponent.health,
        state: opponent.state,
        facing: opponent.facing,
      },
      roundTimer: Math.round(this.game.roundTimer),
      distance: Math.round(Math.abs(fighter.x - opponent.x)),
    };

    this.session.send(state);
  }

  /** Update facing for semantic commands */
  setFacing(facing) {
    this.command.setFacing(facing);
  }

  update(dt) {
    this.command.update(dt);
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
