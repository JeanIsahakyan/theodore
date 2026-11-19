// `cloudflare:workers` outside workerd: the OAuth provider only checks
// whether a handler class extends `WorkerEntrypoint` (ours are objects).
export class WorkerEntrypoint {}
