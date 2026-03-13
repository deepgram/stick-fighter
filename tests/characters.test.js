/**
 * Tests for character selection and LLMAdapter character support.
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

describe('LLMAdapter character support', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch.mockReset();
  });

  test('constructor stores character', () => {
    const adapter = new LLMAdapter(2, 'anthropic', 'haiku');
    expect(adapter.character).toBe('haiku');
    expect(adapter.provider).toBe('anthropic');
    expect(adapter.player).toBe(2);
  });

  test('constructor defaults character to null', () => {
    const adapter = new LLMAdapter(1, 'openai');
    expect(adapter.character).toBeNull();
  });

  test('_requestPlan sends character in body when set', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward', 'light punch'] }),
    });

    const adapter = new LLMAdapter(2, 'anthropic', 'haiku');
    adapter._running = true;
    adapter._ready = true;

    // Set up a mock game ref
    adapter.game = {
      p1: { x: 100, y: 0, health: 200, state: 'idle', grounded: true },
      p2: { x: 300, y: 0, health: 200, state: 'idle', grounded: true },
      roundOver: false,
      waitingForProviders: false,
      fightAlert: 0,
      roundTimer: 60,
    };

    await adapter._requestPlan();

    expect(global.fetch).toHaveBeenCalledWith('/api/llm/command', expect.objectContaining({
      method: 'POST',
    }));

    const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(callBody.character).toBe('haiku');
    expect(callBody.provider).toBe('anthropic');
  });

  test('_requestPlan omits character when null', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ plan: ['forward'] }),
    });

    const adapter = new LLMAdapter(2, 'openai');
    adapter._running = true;
    adapter._ready = true;
    adapter.game = {
      p1: { x: 100, y: 0, health: 200, state: 'idle', grounded: true },
      p2: { x: 300, y: 0, health: 200, state: 'idle', grounded: true },
      roundOver: false,
      waitingForProviders: false,
      fightAlert: 0,
      roundTimer: 60,
    };

    await adapter._requestPlan();

    const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(callBody.character).toBeUndefined();
    expect(callBody.provider).toBe('openai');
  });
});
