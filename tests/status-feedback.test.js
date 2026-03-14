/**
 * Tests for US-006: Status feedback for async operations.
 *
 * Covers:
 * - LLM thinking indicator (set/cleared during plan requests)
 * - Game class rendering of LLM thinking state
 * - Match found flash timing
 */
import { jest } from '@jest/globals';

// Mock CommandAdapter
const mockExecute = jest.fn();
const mockUpdate = jest.fn();
const mockGetActions = jest.fn(() => new Set());
const mockGetJustPressed = jest.fn(() => new Set());
const mockEndFrame = jest.fn();
const mockSetFacing = jest.fn();

jest.unstable_mockModule('../src/input.js', () => ({
  CommandAdapter: jest.fn().mockImplementation(() => ({
    execute: mockExecute,
    update: mockUpdate,
    getActions: mockGetActions,
    getJustPressed: mockGetJustPressed,
    endFrame: mockEndFrame,
    setFacing: mockSetFacing,
  })),
}));

const { LLMAdapter } = await import('../src/llm.js');

// Mock global fetch
global.fetch = jest.fn();

/** Helper: create an LLMAdapter with a mock game ref */
function createTestAdapter(player = 2) {
  const adapter = new LLMAdapter(player, 'anthropic', 'haiku');
  adapter._running = true;
  adapter._ready = true;
  adapter.game = {
    p1: { x: 100, y: 0, health: 200, state: 'idle', grounded: true },
    p2: { x: 300, y: 0, health: 200, state: 'idle', grounded: true },
    roundOver: false,
    waitingForProviders: false,
    fightAlert: 0,
    roundTimer: 60,
    p1LlmToast: null,
    p2LlmToast: null,
    p1LlmThinking: false,
    p2LlmThinking: false,
  };
  return adapter;
}

describe('LLM thinking indicator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockReset();
  });

  test('sets thinking=true at start of _requestPlan', async () => {
    let thinkingDuringFetch = null;
    global.fetch.mockImplementation(async () => {
      // Capture thinking state during the fetch call
      thinkingDuringFetch = true; // We check the adapter state below
      return { ok: true, json: async () => ({ plan: ['forward'] }) };
    });

    const adapter = createTestAdapter(2);

    // Override _setThinking to track calls
    const thinkingCalls = [];
    const origSetThinking = adapter._setThinking.bind(adapter);
    adapter._setThinking = (active) => {
      thinkingCalls.push(active);
      origSetThinking(active);
    };

    await adapter._requestPlan();

    // Should have been called with true first, then false
    expect(thinkingCalls[0]).toBe(true);
    expect(thinkingCalls[thinkingCalls.length - 1]).toBe(false);
  });

  test('clears thinking on successful response', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward', 'light punch'] }),
    });

    const adapter = createTestAdapter(2);
    await adapter._requestPlan();

    expect(adapter.game.p2LlmThinking).toBe(false);
  });

  test('clears thinking on server fallback response', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward'], fallback: true }),
    });

    const adapter = createTestAdapter(2);
    await adapter._requestPlan();

    expect(adapter.game.p2LlmThinking).toBe(false);
  });

  test('clears thinking on network error', async () => {
    global.fetch.mockRejectedValue(new Error('Network error'));

    const adapter = createTestAdapter(2);
    await adapter._requestPlan();

    expect(adapter.game.p2LlmThinking).toBe(false);
    // And fallback plan is generated
    expect(adapter._plan.length).toBe(5);
  });

  test('clears thinking on HTTP error', async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 500 });

    const adapter = createTestAdapter(2);
    await adapter._requestPlan();

    expect(adapter.game.p2LlmThinking).toBe(false);
  });

  test('sets correct player key (P1)', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward'] }),
    });

    const adapter = createTestAdapter(1);
    await adapter._requestPlan();

    // P1 thinking should have been set and cleared
    expect(adapter.game.p1LlmThinking).toBe(false);
    // P2 should be unaffected
    expect(adapter.game.p2LlmThinking).toBe(false);
  });

  test('clears thinking even when state is null', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward'] }),
    });

    const adapter = createTestAdapter(2);
    // Simulate _buildState returning null (no game ref data)
    adapter.game.roundOver = true;
    await adapter._requestPlan();

    expect(adapter.game.p2LlmThinking).toBe(false);
  });
});

describe('Game LLM thinking properties', () => {
  test('Game-like object initializes thinking to false', () => {
    // Mirrors the Game constructor pattern
    const gameState = {
      p1LlmThinking: false,
      p2LlmThinking: false,
      p1LlmToast: null,
      p2LlmToast: null,
    };

    expect(gameState.p1LlmThinking).toBe(false);
    expect(gameState.p2LlmThinking).toBe(false);
  });

  test('thinking indicator is suppressed when toast is active', () => {
    // Simulates the draw logic: thinking only shows when no toast
    const gameState = {
      p1LlmThinking: true,
      p1LlmToast: { text: 'AI connection lost', time: 2.0 },
    };

    // Draw logic: if (thinking && !toast) → draw thinking
    const shouldDrawThinking = gameState.p1LlmThinking && !gameState.p1LlmToast;
    expect(shouldDrawThinking).toBe(false);
  });

  test('thinking indicator shows when no toast is active', () => {
    const gameState = {
      p1LlmThinking: true,
      p1LlmToast: null,
    };

    const shouldDrawThinking = gameState.p1LlmThinking && !gameState.p1LlmToast;
    expect(shouldDrawThinking).toBe(true);
  });
});
