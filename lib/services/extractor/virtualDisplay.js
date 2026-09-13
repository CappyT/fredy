/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { spawn } from 'node:child_process';

/**
 * Start a private Xvfb display. Xvfb selects a free display and writes its number
 * to fd 3 only once ready. No process-wide DISPLAY mutation is needed, so
 * concurrent browser launches cannot overwrite each other's environment.
 *
 * @returns {Promise<{display: string, close: () => Promise<void>}>}
 * @throws {Error} If Xvfb is missing, exits early, or fails to become ready.
 */
export async function startVirtualDisplay() {
  const child = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1366x768x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  let closing;
  const onProcessExit = () => child.kill('SIGKILL');
  process.once('exit', onProcessExit);

  const close = () => {
    if (closing) return closing;
    process.removeListener('exit', onProcessExit);
    closing = new Promise((resolve) => {
      if (child.exitCode != null || child.signalCode != null || child.pid == null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
    return closing;
  };

  try {
    const display = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Xvfb did not become ready within 5 seconds.')), 5000);
      const finish = (error, value) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      child.once('error', (cause) =>
        finish(new Error('Cannot start Xvfb. Install xvfb or use puppeteerHeadless: true.', { cause })),
      );
      child.once('exit', () => finish(new Error('Xvfb exited before its display became ready.')));
      child.stdio[3].on('data', (chunk) => {
        output += chunk.toString();
        if (!output.includes('\n')) return;
        const number = output.trim();
        if (!/^\d+$/.test(number)) finish(new Error('Xvfb returned an invalid display number.'));
        else finish(null, `:${number}`);
      });
    });
    return { display, close };
  } catch (error) {
    await close();
    throw error;
  }
}
