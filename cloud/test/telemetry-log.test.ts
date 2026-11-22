import { describe, expect, it, vi } from 'vitest';
import {
  consoleSink,
  Logger,
  REMOTE_INFO,
  type LogRecord,
  type LogSink,
} from '../src/telemetry/log';
import {
  hashIdentities,
  hashText,
  isContentField,
  isCredentialField,
  redactAttrs,
  redactText,
} from '../src/telemetry/redact';

function capture(): LogSink & { local_: LogRecord[]; remote_: LogRecord[] } {
  const local_: LogRecord[] = [];
  const remote_: LogRecord[] = [];
  return {
    local_,
    remote_,
    local: (r) => local_.push(r),
    remote: (r) => remote_.push(r),
  };
}

const JWT =
  'eyJhbGciOiJSUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ1c2VyXzEiLCJleHAiOjF9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

describe('redaction', () => {
  it('removes secrets from any text', () => {
    const text = `Bearer ${JWT} and ghp_${'a'.repeat(36)} sk_test_abcdefghij api-key=eu01xxabc`;
    const out = redactText(text);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk_test_abcdefghij');
    expect(out).not.toContain('eu01xxabc');
    expect(out).toContain('[redacted]');
  });

  it('hashes emails, keeps the rest', () => {
    const out = redactText('from Ann <ann@example.test>: ok');
    expect(out).not.toContain('ann@example.test');
    expect(out).toContain(`<email:${hashText('ann@example.test')}>`);
    expect(out).toContain(': ok');
  });

  it('cuts long strings', () => {
    const out = redactText('x'.repeat(5000));
    expect(out.length).toBeLessThan(2100);
    expect(out).toContain('[truncated 2952 chars]');
  });

  it('names credential and content fields', () => {
    for (const f of [
      'token',
      'access_token',
      'authorization',
      'nonce',
      'signature',
      'api_key',
      'push.token',
    ]) {
      expect(isCredentialField(f), f).toBe(true);
    }
    expect(isCredentialField('public_key')).toBe(false);
    expect(isCredentialField('device_kind')).toBe(false);
    for (const f of ['body', 'goal', 'envelope', 'message', 'name', 'text']) {
      expect(isContentField(f), f).toBe(true);
    }
    expect(isContentField('error.message')).toBe(false);
    expect(isContentField('error.code')).toBe(false);
  });

  it('redacts attributes before any sink', () => {
    const out = redactAttrs({
      token: 'secret-token',
      goal: 'fix the login bug',
      envelope: { device_id: 'd', body: '{"x":1}', signature: 'sig' },
      email: 'a@b.co',
      device_id: 'dev_1',
      ms: 12,
      ok: true,
      nested: { authorization: `Bearer ${JWT}` },
      none: undefined,
      fn: () => 1,
    });
    expect(out.token).toBe('[redacted]');
    expect(out.goal).toBe('[omitted: 17 bytes]');
    expect(String(out.envelope)).toMatch(/^\[omitted: \d+ bytes\]$/);
    expect(String(out.email)).toMatch(/^\[omitted/);
    expect(out.device_id).toBe('dev_1');
    expect(out.ms).toBe(12);
    expect(out.ok).toBe(true);
    expect(String(out.nested)).not.toContain(JWT);
    expect('none' in out).toBe(false);
    expect('fn' in out).toBe(false);
  });

  it('hashes identities for the remote sink only', () => {
    const out = hashIdentities({
      user_id: 'user_1',
      org_id: 'org_1',
      device_id: 'dev_1',
      ms: 1,
    });
    expect(out.user_id).toBe(`h:${hashText('user_1')}`);
    expect(out.org_id).toBe(`h:${hashText('org_1')}`);
    expect(out.device_id).toBe('dev_1');
    expect(out.ms).toBe(1);
    // Idempotent: a hashed value stays as it is.
    expect(hashIdentities(out).user_id).toBe(out.user_id);
  });
});

describe('Logger', () => {
  it('writes every record locally, warn/error and selected info remotely', () => {
    const sink = capture();
    const log = new Logger(
      sink,
      { component: 'test' },
      () => 1_700_000_000_000,
    );
    log.info('something happened', { a: 1 });
    log.info('http request', {
      route: '/v1/health',
      status: 200,
      user_id: 'user_1',
    });
    log.warn('slow', { ms: 900 });
    log.error('broke');
    expect(sink.local_.map((r) => r.msg)).toEqual([
      'something happened',
      'http request',
      'slow',
      'broke',
    ]);
    expect(sink.remote_.map((r) => r.msg)).toEqual([
      'http request',
      'slow',
      'broke',
    ]);
    expect(sink.local_[1]?.attrs.user_id).toBe('user_1');
    expect(sink.remote_[0]?.attrs.user_id).toBe(`h:${hashText('user_1')}`);
    expect(sink.remote_[0]?.attrs.component).toBe('test');
    expect(sink.remote_[0]?.ts).toBe(1_700_000_000_000);
  });

  it('never carries a token, an email or a text through', () => {
    const sink = capture();
    const log = new Logger(sink);
    log.warn(`refused Bearer ${JWT}`, {
      access_token: 'secret-token',
      goal: 'delete everything for ann@example.test',
      reason: 'token expired for ann@example.test',
      envelope: { body: 'hello world' },
    });
    const text = JSON.stringify([...sink.local_, ...sink.remote_]);
    expect(text).not.toContain('secret-token');
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('ann@example.test');
    expect(text).not.toContain('hello world');
    expect(text).not.toContain('delete everything');
  });

  it('describes an exception without its payload', () => {
    const sink = capture();
    const log = new Logger(sink);
    const e = new Error(`fetch failed for ann@example.test with Bearer ${JWT}`);
    log.exception('push failed', e, { provider: 'expo' });
    const r = sink.remote_[0]!;
    expect(r.level).toBe('error');
    expect(r.attrs['error.kind']).toBe('Error');
    expect(String(r.attrs['error.message'])).not.toContain(JWT);
    expect(String(r.attrs['error.message'])).not.toContain('ann@');
    expect(String(r.attrs['error.stack'])).toContain('Error');
    expect(r.attrs.provider).toBe('expo');
  });

  it('children keep their base attributes', () => {
    const sink = capture();
    const log = new Logger(sink).child({ component: 'hub', token: 'x' });
    log.warn('hi', { a: 1 });
    expect(sink.remote_[0]?.attrs).toEqual({
      component: 'hub',
      token: '[redacted]',
      a: 1,
    });
  });

  it('prints JSON lines to the console, the method by level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger(consoleSink, {}, () => 0);
    logger.info('a', { x: 1 });
    logger.warn('b');
    logger.error('c');
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'a',
      x: 1,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('keeps the remote info events to a fixed set', () => {
    expect([...REMOTE_INFO]).toContain('http request');
    expect([...REMOTE_INFO]).toContain('fleet connected');
    expect(REMOTE_INFO.has('something happened')).toBe(false);
  });
});
