// ─────────────────────────────────────────────
// LLMAdapter — AI fighter via Anthropic Claude / OpenAI
//
// Sends game state → server → LLM → returns 5-move plan.
// Executes one move per second from the plan.
// When the plan is exhausted, requests a fresh one with current state.
// ─────────────────────────────────────────────
import { CommandAdapter } from './input.js';

const MAX_HISTORY = 10;       // max messages in conversation
const MOVE_INTERVAL = 1000;   // ms between executing each move from the plan

export class LLMAdapter {
  constructor(player, provider = 'anthropic') {
    this.player = player;
    this.provider = provider;
    this.command = new CommandAdapter();
    this.game = null;
    this._running = false;
    this._messages = [];
    this._ready = false;
    this._readyResolve = null;

    // Plan state
    this._plan = [];           // current move queue
    this._planIndex = 0;       // next move to execute
    this._moveTimer = 0;       // ms since last move executed
    this._requesting = false;  // true while waiting for LLM response

    // Track health for effectiveness feedback
    this._prevMyHp = 200;
    this._prevOppHp = 200;
    this._lastPlanDealt = 0;
    this._lastPlanTaken = 0;

    // Tactic tracking: command → { dealt, taken, uses }
    this._tactics = {};
    this._lastCommand = null;
  }

  setGameRef(game) {
    this.game = game;
  }

  async attach() {
    this._running = true;
    this._ready = true;
    if (this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
    }
    // Plan request is triggered by update() once game ref is set
  }

  async detach() {
    this._running = false;
    this._ready = false;
    this._messages = [];
    this._plan = [];
    this._planIndex = 0;
    this._requesting = false;
    this.game = null;
  }

  waitUntilReady() {
    if (this._ready) return Promise.resolve();
    return new Promise(resolve => { this._readyResolve = resolve; });
  }

  /** Called every frame by the game loop */
  update(dt) {
    this.command.update(dt);

    if (!this._running || !this.game) return;
    if (this.game.roundOver || this.game.waitingForProviders || this.game.fightAlert > 0) return;

    // Tick move timer (dt is in seconds, _moveTimer is in ms)
    this._moveTimer += dt * 1000;

    // Execute next move from plan if interval has elapsed
    if (this._plan.length > 0 && this._planIndex < this._plan.length) {
      if (this._moveTimer >= MOVE_INTERVAL) {
        const move = this._plan[this._planIndex];
        console.log(`[LLM P${this.player}] execute [${this._planIndex + 1}/${this._plan.length}]: "${move}"  (timer=${Math.round(this._moveTimer)}ms)`);

        // Track tactic for the previous move's outcome
        this._trackTactic();

        this._lastCommand = move;
        this.command.execute(move);
        this._planIndex++;
        this._moveTimer = 0;

        // Snapshot health after executing (for next move's delta)
        this._snapshotHealth();
      }
    } else if (!this._requesting) {
      // Plan exhausted or empty — request a new one
      this._trackTactic();
      this._requestPlan();
    }
  }

  /** Snapshot current health for delta tracking */
  _snapshotHealth() {
    if (!this.game) return;
    const me = this.player === 1 ? this.game.p1 : this.game.p2;
    const opp = this.player === 1 ? this.game.p2 : this.game.p1;
    this._prevMyHp = me.health;
    this._prevOppHp = opp.health;
  }

  /** Track effectiveness of the last executed command */
  _trackTactic() {
    if (!this._lastCommand || !this.game) return;

    const me = this.player === 1 ? this.game.p1 : this.game.p2;
    const opp = this.player === 1 ? this.game.p2 : this.game.p1;
    const dealt = -(opp.health - this._prevOppHp);
    const taken = -(me.health - this._prevMyHp);

    if (!this._tactics[this._lastCommand]) {
      this._tactics[this._lastCommand] = { dealt: 0, taken: 0, uses: 0 };
    }
    const t = this._tactics[this._lastCommand];
    t.dealt += dealt;
    t.taken += taken;
    t.uses++;

    // Accumulate plan totals for feedback
    this._lastPlanDealt += dealt;
    this._lastPlanTaken += taken;
  }

  /** Request a fresh 5-move plan from the LLM */
  async _requestPlan() {
    if (this._requesting || !this._running) return;
    this._requesting = true;

    try {
      const state = this._buildState();
      if (!state) {
        this._requesting = false;
        return;
      }

      // Add game state as user message
      this._messages.push({ role: 'user', content: state });
      if (this._messages.length > MAX_HISTORY) {
        this._messages = this._messages.slice(-MAX_HISTORY);
      }

      const t0 = performance.now();
      const resp = await fetch('/api/llm/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: this.provider, messages: this._messages }),
      });
      const elapsed = performance.now() - t0;

      if (!resp.ok) {
        console.error(`[LLM P${this.player}] API error: ${resp.status}`);
        await _sleep(1000);
        this._requesting = false;
        return;
      }

      const data = await resp.json();
      console.log(`[LLM P${this.player}] response:`, JSON.stringify(data));
      const plan = data.plan;
      if (plan && plan.length > 0) {
        console.log(`[LLM P${this.player}] new plan (${Math.round(elapsed)}ms): ${JSON.stringify(plan)}`);
        this._messages.push({ role: 'assistant', content: JSON.stringify(plan) });
        this._plan = plan;
        this._planIndex = 0;
        this._moveTimer = MOVE_INTERVAL; // execute first move immediately
        this._lastPlanDealt = 0;
        this._lastPlanTaken = 0;
      } else {
        console.warn(`[LLM P${this.player}] empty/missing plan in response:`, data);
      }
    } catch (e) {
      console.error(`[LLM P${this.player}] Error:`, e);
      await _sleep(1000);
    } finally {
      this._requesting = false;
    }
  }

  /** Build compact game state string with plan outcome feedback */
  _buildState() {
    if (!this.game) return null;

    const me = this.player === 1 ? this.game.p1 : this.game.p2;
    const opp = this.player === 1 ? this.game.p2 : this.game.p1;
    const dist = Math.round(Math.abs(me.x - opp.x));

    const parts = [
      `T${Math.ceil(this.game.roundTimer)}`,
      `ME:${Math.round(me.x)},${Math.round(me.y)} hp${me.health} ${me.state}${me.grounded ? '' : ' air'}`,
      `OPP:${Math.round(opp.x)},${Math.round(opp.y)} hp${opp.health} ${opp.state}${opp.grounded ? '' : ' air'}`,
      `D${dist}`,
    ];

    // Add outcome of previous plan
    if (this._plan.length > 0) {
      const dealt = this._lastPlanDealt;
      const taken = this._lastPlanTaken;
      if (dealt > 0 && taken > 0) parts.push(`PLAN_RESULT:traded dealt=${dealt} took=${taken}`);
      else if (dealt > 0) parts.push(`PLAN_RESULT:hit! dealt=${dealt}`);
      else if (taken > 0) parts.push(`PLAN_RESULT:got hit, took=${taken}`);
      else parts.push(`PLAN_RESULT:no damage`);
    }

    // Add best tactics summary (top 3 by net damage)
    const tacticEntries = Object.entries(this._tactics)
      .filter(([, t]) => t.uses >= 2)
      .map(([cmd, t]) => ({ cmd, net: t.dealt - t.taken, avg: ((t.dealt - t.taken) / t.uses).toFixed(1), uses: t.uses }))
      .sort((a, b) => b.net - a.net);

    if (tacticEntries.length > 0) {
      const best = tacticEntries.slice(0, 3)
        .map(t => `${t.cmd}(net=${t.avg}/use x${t.uses})`)
        .join(', ');
      parts.push(`BEST:${best}`);
    }

    // Snapshot for deltas
    this._snapshotHealth();

    return parts.join(' | ');
  }

  setFacing(facing) {
    this.command.setFacing(facing);
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

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
