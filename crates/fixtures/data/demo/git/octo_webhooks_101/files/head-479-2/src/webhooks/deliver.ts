export async function deliver(hook: Webhook, event: Event) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const res = await fetch(hook.url, { method: 'POST', body: JSON.stringify(event) });
    if (res.ok) return;
    if (res.status < 500 && res.status !== 429) break;
    await sleep(backoff(attempt));
  }
  await deadLetter.push(hook, event);
}
