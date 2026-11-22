/** A request that didn't succeed; `code` is a refusal code when there is one. */
export class FleetError extends Error {
  constructor(
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'FleetError';
  }
}
