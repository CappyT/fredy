/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
import { startVirtualDisplay } from '../../../lib/services/extractor/virtualDisplay.js';

let child;
beforeEach(() => {
  child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null, stdio: [null, null, null, new PassThrough()] });
  child.kill = vi.fn((signal) => {
    child.signalCode = signal;
    child.emit('exit');
    return true;
  });
  spawnMock.mockReset().mockReturnValue(child);
});
afterEach(() => vi.useRealTimers());

describe('private Xvfb display', () => {
  it('waits for a complete display number and closes the process once', async () => {
    const pending = startVirtualDisplay();
    child.stdio[3].write('12');
    child.stdio[3].write('3\n');
    const display = await pending;
    expect(display.display).toBe(':123');
    expect(spawnMock.mock.calls[0][1]).toContain('-displayfd');
    await Promise.all([display.close(), display.close()]);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('reports a missing executable', async () => {
    const pending = startVirtualDisplay();
    child.pid = undefined;
    child.emit('error', new Error('ENOENT'));
    await expect(pending).rejects.toThrow('Install xvfb');
  });

  it('rejects an early exit', async () => {
    const pending = startVirtualDisplay();
    child.exitCode = 1;
    child.emit('exit');
    await expect(pending).rejects.toThrow('exited before');
  });

  it('cleans up after invalid readiness output', async () => {
    const pending = startVirtualDisplay();
    child.stdio[3].write('invalid\n');
    await expect(pending).rejects.toThrow('invalid display');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('times out a display that never becomes ready', async () => {
    vi.useFakeTimers();
    const pending = expect(startVirtualDisplay()).rejects.toThrow('within 5 seconds');
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('force closes a display that ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const pending = startVirtualDisplay();
    child.stdio[3].write('123\n');
    const display = await pending;
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') {
        child.signalCode = signal;
        child.emit('exit');
      }
      return true;
    });
    const closing = display.close();
    await vi.advanceTimersByTimeAsync(2000);
    await closing;
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });
});
