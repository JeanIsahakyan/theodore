/**
 * The one boundary between the UI and the Rust core. Everything the UI knows
 * about Tauri lives behind this interface — components and stores never
 * import `@tauri-apps/api` directly, so tests swap in a fake.
 */
export type Unlisten = () => void;

/** The invoke header that carries a call's operation id: the core puts it
 *  on every log record of that command, so one failure can be followed
 *  from the UI through the core to the agent and the host. */
export const OP_HEADER = 'x-theodore-op';

export interface InvokeOptions {
  opId?: string;
}

export interface Transport {
  invoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
    opts?: InvokeOptions,
  ): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
}

export class TauriTransport implements Transport {
  async invoke<T>(
    cmd: string,
    args?: Record<string, unknown>,
    opts?: InvokeOptions,
  ): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return opts?.opId
      ? invoke<T>(cmd, args, { headers: { [OP_HEADER]: opts.opId } })
      : invoke<T>(cmd, args);
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
