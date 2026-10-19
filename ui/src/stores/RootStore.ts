import { getTransport } from '../core/transport';
import { resourceCache, type ResourceCache } from '../core/resource';
import { SyncClient, modelAccessors, type ModelAccessors } from '../sync';
import type { Ephemeral, Revision } from '../gen/contract';
import { reaction } from 'mobx';
import { loadAppInfo, loadViewer } from '../actions';
import { windowTitle } from '../ui/sandbox/sandbox';
import { setCommandFailureHandler } from '../core/api';
import { EphemeralStore } from './EphemeralStore';
import { UiStore } from './UiStore';

export class RootStore {
  readonly sync = new SyncClient();
  readonly models: ModelAccessors = modelAccessors(this.sync.pool);
  readonly ephemeral = new EphemeralStore();
  readonly ui = new UiStore();

  /** Revision at `<pr>@<head>`; immutable once fetched. */
  readonly revisions: ResourceCache<Revision> = resourceCache({ limit: 50 });
  /** File contents at `<rev>:<path>`; immutable once fetched. */
  readonly files: ResourceCache<string | null> = resourceCache({ limit: 500 });

  private unlistenEphemeral: (() => void) | undefined;
  private disposeTitle: (() => void) | undefined;

  async start(): Promise<void> {
    setCommandFailureHandler((f) =>
      this.ephemeral.handle({ type: 'toast', level: 'warn', text: f.message }),
    );
    this.unlistenEphemeral = await getTransport().listen<Ephemeral>(
      'ephemeral',
      (e) => this.ephemeral.handle(e),
    );
    // `[SANDBOX] ` in front of the window title while in sandbox mode.
    this.disposeTitle = reaction(
      () => this.ephemeral.sandbox,
      (sandbox) => {
        document.title = windowTitle(document.title, sandbox);
      },
      { fireImmediately: true },
    );
    void loadAppInfo(this);
    await this.sync.start();
    void loadViewer(this);
  }

  dispose(): void {
    this.sync.dispose();
    this.unlistenEphemeral?.();
    this.disposeTitle?.();
  }
}
