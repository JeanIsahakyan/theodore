import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  askPresentation,
  clip,
  EXPO_PUSH_URL,
  expoSender,
  type PushMessage,
} from '../src/fleet/push';

const msg = (to: string): PushMessage => ({
  to,
  title: 't',
  body: 'b',
  channelId: 'default',
  data: {
    kind: 'finished',
    ask_id: '',
    space: 's',
    host_device: 'h',
    options: [],
  },
});

/**
 * The app's side of the push contract (mobile/src/push/contract.ts), which
 * the hub's port must match. Read and compiled here, alone (it imports
 * nothing), so the test needs nothing from mobile/'s install: Vite would
 * load that package's tsconfig, which extends Expo's.
 */
function appContract(): {
  askPresentation: typeof askPresentation;
} {
  const source = readFileSync(
    new URL('../../mobile/src/push/contract.ts', import.meta.url),
    'utf8',
  );
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function('exports', js)(exports);
  return exports as ReturnType<typeof appContract>;
}

const appPresentation = appContract().askPresentation;

describe('askPresentation', () => {
  const long = 'x'.repeat(300);
  const cases: [string, string[]][] = [
    ['Which DB?', ['pg', 'sqlite']],
    ['Which DB?', ['pg', 'sqlite', 'mysql']],
    ['Free text?', []],
    ['One option', ['only']],
    ['Four', ['a', 'b', 'c', 'd']],
    ['Five', ['a', 'b', 'c', 'd', 'e']],
    [long, ['yes', 'no']],
    ['Long options', [long, long, long]],
    ['  spaced\n\nout  question ', ['  a  b ', 'c\nd']],
    ['Ünïcödé — “quotes”', ['é', '漢字']],
  ];

  it('matches the app’s contract', () => {
    for (const [q, opts] of cases) {
      expect(askPresentation(q, opts)).toEqual(appPresentation(q, opts));
    }
  });

  it('lists options for two or three, falls back to text otherwise', () => {
    expect(askPresentation('Which DB?', ['pg', 'sqlite'])).toEqual({
      body: 'Which DB?\n1) pg  2) sqlite',
      categoryId: 'ask_opt2',
    });
    expect(askPresentation('Four', ['a', 'b', 'c', 'd']).categoryId).toBe(
      'ask_text',
    );
    for (const [q, opts] of cases) {
      expect(askPresentation(q, opts).body.length).toBeLessThanOrEqual(180);
    }
  });

  it('clips on one line with an ellipsis', () => {
    expect(clip('a\n b', 10)).toBe('a b');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('expoSender', () => {
  it('posts JSON to Expo and reads one ticket per message', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send = expoSender(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json({
        data: [
          { status: 'ok', id: '1' },
          {
            status: 'error',
            message: 'gone',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', details: { error: 'MessageRateExceeded' } },
        ],
      });
    }, 'expo-secret');
    const out = await send([msg('a'), msg('b'), msg('c')]);
    expect(out).toEqual(['ok', 'unregistered', 'failed']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPO_PUSH_URL);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer expo-secret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual([
      msg('a'),
      msg('b'),
      msg('c'),
    ]);
  });

  it('batches by 100', async () => {
    const sizes: number[] = [];
    const send = expoSender(async (_url, init) => {
      const batch = JSON.parse(String(init!.body)) as unknown[];
      sizes.push(batch.length);
      return Response.json({ data: batch.map(() => ({ status: 'ok' })) });
    });
    const out = await send(Array.from({ length: 150 }, (_, i) => msg(`${i}`)));
    expect(sizes).toEqual([100, 50]);
    expect(out.every((r) => r === 'ok')).toBe(true);
  });

  it('never throws: a network error, a 5xx or junk fail the batch', async () => {
    const down = expoSender(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await down([msg('a')])).toEqual(['failed']);
    const five = expoSender(async () => new Response('no', { status: 503 }));
    expect(await five([msg('a')])).toEqual(['failed']);
    const junk = expoSender(async () => new Response('not json'));
    expect(await junk([msg('a')])).toEqual(['failed']);
  });
});
