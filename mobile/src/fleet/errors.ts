/** A request that didn't succeed; `code` is a refusal code when there is
 *  one. `timeout`: the host's answer didn't come in time, so it may still
 *  have taken the request (a send: its row can show up later). */
export class FleetError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
    readonly timeout: boolean = false,
  ) {
    super(message);
    this.name = 'FleetError';
  }
}

/** The request may have reached the host even though it failed here. */
export const mayHaveReached = (e: unknown): boolean =>
  e instanceof FleetError && e.timeout;
