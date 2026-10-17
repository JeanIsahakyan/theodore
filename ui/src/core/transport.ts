/**
 * The one boundary between the UI and the Rust core. Everything the UI knows
 * about Tauri lives behind this interface — components and stores never
 * import `@tauri-apps/api` directly, so tests swap in a fake.
 */
export type Unlisten = () => void;

export interface Transport {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
}

export class TauriTransport implements Transport {
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten> {
    const { listen } = await import('@tauri-apps/api/event');
    const un = await listen<T>(event, (e) => cb(e.payload));
    return un;
  }
}

let transport: Transport = new TauriTransport();

/** The active transport; tests call `setTransport` with a fake. */
export const getTransport = (): Transport => transport;
export const setTransport = (t: Transport): void => {
  transport = t;
};
