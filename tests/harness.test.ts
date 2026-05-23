import { describe, it, expect } from 'vitest';
import { BotTestHarness } from './harness';
import { BotSystem } from '../src/orchestrator/system';

describe('BotTestHarness', () => {
  it('should initialize a BotSystem with default config', () => {
    const harness = new BotTestHarness();
    expect(harness.system).toBeDefined();
    expect(harness.system).toBeInstanceOf(BotSystem);
  });

  it('should allow overriding config values', () => {
    const harness = new BotTestHarness({
      observability: {
        logLevel: 'debug',
        tuiEnabled: true,
      } as any,
    });
    expect(harness.system.config.observability.logLevel).toBe('debug');
  });
});
