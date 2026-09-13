/*
 * Copyright (c) 2026 by Christian Kellner.
 * Licensed under Apache-2.0 with Commons Clause and Attribution/Naming Clause
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const dockerfile = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../Dockerfile'), 'utf-8');

/**
 * Without an init as pid 1 nobody reaps the Chromium helper processes that get reparented when a
 * browser dies, and the container slowly fills up with `<defunct>` entries. Node cannot do the
 * reaping itself (libuv only waits for the pids it spawned), so this has to stay in the image.
 */
describe('Dockerfile init process', () => {
  it('installs tini', () => {
    expect(dockerfile).toMatch(/apt-get install[\s\S]*?\btini\b/);
  });

  it('runs the app under tini rather than as pid 1', () => {
    const entrypoint = dockerfile.match(/^ENTRYPOINT (.+)$/m)?.[1];
    const cmd = dockerfile.match(/^CMD (.+)$/m)?.[1];

    expect(entrypoint).toBeDefined();
    expect(JSON.parse(entrypoint)).toEqual(['/usr/bin/tini', '-g', '--']);
    // The command wraps node in a shell that raises Xvfb first and execs node once its socket
    // exists - the browser gets a windowed display without a desktop.
    expect(JSON.parse(cmd)).toEqual([
      'sh',
      '-c',
      'Xvfb :99 -screen 0 1366x768x24 -nolisten tcp & for i in $(seq 1 50); do [ -S /tmp/.X11-unix/X99 ] && break; sleep 0.1; done; [ -S /tmp/.X11-unix/X99 ] || { echo "Xvfb did not become ready" >&2; exit 1; }; exec node index.js',
    ]);
  });

  it('does not start Node if the virtual display never becomes ready', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'fredy-display-test-'));
    try {
      // Stub executables: this test must not launch an actual display or application.
      for (const [name, body] of Object.entries({ Xvfb: 'exit 1', sleep: 'exit 0', node: 'echo APP_STARTED' })) {
        writeFileSync(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      }
      const command = JSON.parse(dockerfile.match(/^CMD (.+)$/m)[1]);
      // Isolate the socket path from any display already running on the test host.
      const args = command.slice(1).map((arg) => arg.replaceAll('/tmp/.X11-unix/X99', path.join(directory, 'X99')));
      const result = spawnSync(command[0], args, {
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Xvfb did not become ready');
      expect(result.stdout).not.toContain('APP_STARTED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('gives the browser a display to open a window in', () => {
    expect(dockerfile).toMatch(/apt-get install[\s\S]*?\bxvfb\b/);
    expect(dockerfile).toMatch(/^ENV [\s\S]*?DISPLAY=:99/m);
  });
});
