// WebdriverIO config for the real Theodore app over `tauri-driver`
// (plan §12.1). `tauri-driver` has no macOS driver for WKWebView, so this
// only runs on Linux (the `ui-e2e` CI job, `ubuntu-latest` + webkit2gtk); see
// `e2e/README.md` for how to run it there. On macOS, `pnpm typecheck` is the
// signal this config and the specs compile.

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Capabilities, Options } from '@wdio/types';

// Built by the CI job before this runs (`cargo tauri build --debug`); set
// explicitly rather than guessed, so a stale binary never runs silently.
const application = process.env.TAURI_APP_BINARY;
if (!application) {
  throw new Error(
    'Set TAURI_APP_BINARY to the Theodore debug binary before running wdio ' +
      '(see e2e/README.md).',
  );
}

// `tauri-driver` spawns `application` itself, inheriting this process's
// env — so `THEODORE_FIXTURES` (read by `theodore_runtime::RuntimeConfig`)
// must already be set in the shell that starts `wdio run`.
if (!process.env.THEODORE_FIXTURES) {
  throw new Error(
    'Set THEODORE_FIXTURES to crates/fixtures/data/demo before running wdio ' +
      '(see e2e/README.md).',
  );
}

let tauriDriver: ChildProcess | undefined;

export const config: Options.Testrunner & Capabilities.WithRequestedTestrunnerCapabilities = {
  runner: 'local',
  specs: ['./specs/**/*.e2e.ts'],
  maxInstances: 1,
  // `tauri:options` isn't a WebdriverIO-typed capability; `tauri-driver`
  // only needs the binary path, no `browserName`.
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application,
      },
    } as Capabilities.RequestedStandaloneCapabilities,
  ],
  logLevel: 'warn',
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 60_000,
  },
  reporters: ['spec'],

  // `tauri-driver` proxies WebDriver to the app's native webview; it must
  // already be on PATH (`cargo install tauri-driver`, see README).
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',

  onPrepare: () => {
    tauriDriver = spawn('tauri-driver', [], {
      cwd: path.resolve(__dirname),
      stdio: [null, process.stdout, process.stderr],
    });
  },

  onComplete: () => {
    tauriDriver?.kill();
  },
};
