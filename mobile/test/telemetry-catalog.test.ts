import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  EVENT_NAMES,
  NEVER_SENT,
  allowedProps,
  catalogRows,
  isCatalogEvent,
} from '../src/telemetry/catalog';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'gen' && name !== 'node_modules') walk(p, out);
    } else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('the event catalog', () => {
  it('names events in snake_case with snake_case props', () => {
    for (const name of EVENT_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const p of CATALOG[name].props) expect(p).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(CATALOG[name].answers.length).toBeGreaterThan(8);
    }
  });

  it('drops unknown props and cuts long strings', () => {
    const out = allowedProps('space_started', {
      mode: 'edit',
      ms: 120,
      goal: 'never',
      text: 'never',
      code: null,
      agent: 'x'.repeat(300),
      nested: { a: 1 },
    });
    expect(out).toEqual({
      mode: 'edit',
      ms: 120,
      code: null,
      agent: 'x'.repeat(100),
    });
    expect('goal' in out).toBe(false);
    expect('nested' in out).toBe(false);
  });

  it('knows its events and nothing else', () => {
    expect(isCatalogEvent('fleet_request')).toBe(true);
    expect(isCatalogEvent('made_up')).toBe(false);
    expect(isCatalogEvent('toString')).toBe(false);
  });

  it('lists every event for "What\'s collected", and what is never sent', () => {
    const rows = catalogRows();
    expect(rows.map((r) => r.name)).toEqual(EVENT_NAMES);
    expect(NEVER_SENT.some((l) => /messages/.test(l))).toBe(true);
    expect(NEVER_SENT.some((l) => /email/.test(l))).toBe(true);
    expect(NEVER_SENT.some((l) => /Tokens/.test(l))).toBe(true);
  });

  it('is used by every track() call in the source', () => {
    const files = [
      ...walk(join(__dirname, '..', 'src')),
      ...walk(join(__dirname, '..', 'app')),
    ];
    const used = new Set<string>();
    const unknown: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\btrack\(\s*'([^']+)'/g)) {
        used.add(m[1]!);
        if (!isCatalogEvent(m[1]!)) unknown.push(`${f}: ${m[1]}`);
      }
      // A dynamic name would escape the check above.
      for (const m of text.matchAll(/\btrack\(\s*([a-zA-Z_$][\w$.]*)\s*[,)]/g)) {
        if (m[1] !== 'event') unknown.push(`${f}: track(${m[1]}) is not a literal`);
      }
    }
    expect(unknown).toEqual([]);
    expect(used.size).toBeGreaterThan(15);
  });

  it('never names a property that would carry text', () => {
    const banned = /^(text|goal|message|title|name|email|body|path|url|reply)$/;
    for (const name of EVENT_NAMES)
      for (const p of CATALOG[name].props) expect(p).not.toMatch(banned);
  });
});
