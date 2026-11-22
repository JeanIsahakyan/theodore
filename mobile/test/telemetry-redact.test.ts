import { describe, expect, it } from 'vitest';
import {
  errorFields,
  hashWith,
  isContentField,
  isCredentialField,
  isNamedField,
  redactFields,
  redactRecord,
  redactText,
} from '../src/telemetry/redact';
import type { TelemetryRecord } from '../src/telemetry/types';

const KEY = 'install-1';
const local = { key: KEY, remote: false };
const remote = { key: KEY, remote: true };

describe('redactText', () => {
  it('takes tokens out of free text', () => {
    const cases = [
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'github_pat_11ABCDEFG0123456789abcdefghijklmnop',
      'glpat-abcdefghijklmnopqrstuv',
      'sk-abcdefghijklmnopqrstuvwxyz',
      'sk_live_abcdefghijklmnop',
      'AKIAABCDEFGHIJKLMNOP',
      'xoxb-1234567890-abcdefghijk',
      'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
      'npm_abcdefghijklmnopqrstuvwxyz0123456789',
      'phc_abcdefghijklmnopqrstuvwxyz',
      'ExponentPushToken[abcDEF123]',
      'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.c2lnbmF0dXJlYWJj',
    ];
    for (const secret of cases) {
      const out = redactText(`before ${secret} after`, KEY);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toContain('[redacted]');
    }
  });

  it('keeps the shape of headers, URLs and pairs, drops the value', () => {
    expect(
      redactText('Authorization: Bearer abc.def.ghi-jkl', KEY),
    ).not.toContain('abc.def');
    expect(redactText('https://user:pa55word@example.com/x', KEY)).toBe(
      'https://user:[redacted]@example.com/x',
    );
    expect(redactText('https://a.b/cb?code=SECRET1&state=S2', KEY)).toBe(
      'https://a.b/cb?code=[redacted]&state=[redacted]',
    );
    expect(redactText('token=abcdef password: hunter2', KEY)).toBe(
      'token=[redacted] password: [redacted]',
    );
    expect(redactText('WORKOS_API_KEY=sk_test_abcdefghij', KEY)).toBe(
      'WORKOS_API_KEY=[redacted]',
    );
  });

  it('hashes emails, the same email the same way', () => {
    const a = redactText('from jean@example.com', KEY);
    const b = redactText('to Jean@Example.com', KEY);
    expect(a).not.toContain('example.com');
    expect(a).toMatch(/<email:[0-9a-f]{16}>/);
    expect(a.slice(5)).toBe(b.slice(3));
    expect(redactText('git@github.com:o/r.git', KEY)).toBe(
      'git@github.com:o/r.git',
    );
  });

  it('cuts private keys', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----';
    expect(redactText(pem, KEY)).toBe('[redacted]');
  });
});

describe('field rules', () => {
  it('names credential, content and named fields', () => {
    expect(isCredentialField('access_token')).toBe(true);
    expect(isCredentialField('api_key')).toBe(true);
    expect(isCredentialField('code_verifier')).toBe(true);
    expect(isCredentialField('ms')).toBe(false);
    expect(isContentField('text')).toBe(true);
    expect(isContentField('goal')).toBe(true);
    expect(isContentField('last_reply')).toBe(true);
    expect(isContentField('title')).toBe(true);
    expect(isContentField('email')).toBe(true);
    expect(isContentField('name')).toBe(true);
    expect(isContentField('user_name')).toBe(true);
    expect(isContentField('host_name')).toBe(false);
    expect(isContentField('project_name')).toBe(false);
    expect(isNamedField('host_name')).toBe(true);
    expect(isNamedField('project_name')).toBe(true);
    expect(isNamedField('path')).toBe(true);
    expect(isNamedField('url')).toBe(true);
    expect(isNamedField('device_id')).toBe(false);
    expect(isNamedField('space_count')).toBe(false);
    expect(isNamedField('target_kind')).toBe(false);
  });

  it('redacts credentials and omits content, locally too', () => {
    const out = redactFields(
      {
        token: 'abc',
        refresh_token: 'xyz',
        text: 'fix the login bug please',
        goal: 'a goal',
        title: 'Fix login',
        email: 'jean@example.com',
        name: 'Jean Isahakyan',
        ms: 12,
        ok: true,
      },
      local,
    );
    expect(out.token).toBe('[redacted]');
    expect(out.refresh_token).toBe('[redacted]');
    expect(out.text).toBe('[omitted: 24 bytes]');
    expect(out.goal).toBe('[omitted: 6 bytes]');
    expect(out.title).toBe('[omitted: 9 bytes]');
    expect(String(out.email)).not.toContain('example');
    expect(String(out.name)).not.toContain('Jean');
    expect(out.ms).toBe(12);
    expect(out.ok).toBe(true);
  });

  it('keeps names locally, hashes them remotely, keeps ids', () => {
    const fields = {
      host_name: 'mac-A',
      project_name: 'theodore',
      branch: 'feat/x',
      path: '/Users/jean/code/app.ts',
      url: 'https://github.com/o/r/pull/1',
      device_id: 'dev_00000000-0000-4000-8000-0000000000b2',
      space: 'rs_abc123def456',
      user: 'user_01ABCDEFGHIJKLMNOPQRS',
    };
    const l = redactFields(fields, local);
    expect(l.host_name).toBe('mac-A');
    expect(l.project_name).toBe('theodore');
    expect(l.path).toBe('~/code/app.ts');
    const r = redactFields(fields, remote);
    expect(r.host_name).toBe(`h:${hashWith(KEY, 'mac-A')}`);
    expect(r.project_name).toMatch(/^h:[0-9a-f]{16}$/);
    expect(r.branch).toMatch(/^h:[0-9a-f]{16}$/);
    expect(r.path).toMatch(/^<path:[0-9a-f]{16}>$/);
    expect(r.url).toMatch(/^https:\/\/github\.com\/<url:[0-9a-f]{16}>$/);
    expect(r.device_id).toBe(fields.device_id);
    expect(r.space).toBe(fields.space);
    expect(r.user).toBe(fields.user);
  });

  it('cuts long values, keeps the end of a tail', () => {
    const long = 'x'.repeat(3000);
    const out = redactFields({ detail: long, stderr_tail: `a${long}` }, local);
    expect(String(out.detail)).toMatch(/…\[truncated 952 bytes\]$/);
    expect(String(out.detail).length).toBeLessThan(2100);
    expect(String(out.stderr_tail)).toMatch(/^…\[truncated \d+ bytes\]x+$/);
  });
});

describe('redactRecord', () => {
  it('redacts the message and every field, leaks nothing', () => {
    const r: TelemetryRecord = {
      ts: 1,
      level: 'warn',
      kind: 'log',
      msg: 'sign-in failed for jean@example.com with ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      fields: { text: 'hello', host_name: 'mac' },
    };
    const out = JSON.stringify(redactRecord(r, remote));
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('hello');
    expect(out).not.toContain('"mac"');
  });

  it('errorFields keeps the message, the stack and a code', () => {
    const e = Object.assign(new Error('boom'), { code: 'fleet.offline' });
    const f = errorFields(e);
    expect(f.error).toBe('boom');
    expect(f['error.code']).toBe('fleet.offline');
    expect(typeof f.stack).toBe('string');
    expect(errorFields('plain')).toEqual({ error: 'plain' });
  });
});
