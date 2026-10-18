import { getTransport } from '../core/transport';
import { resourceCache, type ResourceCache } from '../core/resource';
import { SyncClient, modelAccessors, type ModelAccessors } from '../sync';
import type { Ephemeral, Revision } from '../gen/contract';
import { loadViewer } from '../actions';
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

  async start(): Promise<void> {
    this.unlistenEphemeral = await getTransport().listen<Ephemeral>(
      'ephemeral',
      (e) => this.ephemeral.handle(e),
    );
    await this.sync.start();
    void loadViewer(this);
  }

  dispose(): void {
    this.sync.dispose();
    this.unlistenEphemeral?.();
  }
}
