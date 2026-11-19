import { describe, expect, it } from 'vitest';
import {
  autoExpiry,
  autoUntil,
  autoWarning,
  confirmDeadline,
  confirmTitle,
  confirmWhat,
} from '../src/ui/confirmView';

const base = {
  projectName: 'theodore',
  spaceName: 'fix-login',
  hostName: 'Studio',
};

describe('confirm wording', () => {
  it('says what a start would do, with the right article', () => {
    expect(confirmWhat({ ...base, action: 'start', mode: 'edit' })).toBe(
      'start an Edit space in theodore',
    );
    expect(confirmWhat({ ...base, action: 'start', mode: 'ask' })).toBe(
      'start an Ask space in theodore',
    );
    expect(confirmWhat({ ...base, action: 'start', mode: 'plan' })).toBe(
      'start a Plan space in theodore',
    );
    expect(confirmWhat({ ...base, action: 'start', mode: 'run' })).toBe(
      'start a Run space in theodore',
    );
  });

  it('says what a send or a plan approval would do', () => {
    expect(confirmWhat({ ...base, action: 'send', mode: 'run' })).toBe(
      'send to fix-login in Run',
    );
    expect(confirmWhat({ ...base, action: 'approve_plan', mode: 'edit' })).toBe(
      'approve the plan in fix-login (Edit)',
    );
  });

  it('names the computer and the deadline', () => {
    expect(confirmTitle({ ...base, action: 'start', mode: 'edit' })).toBe(
      'Claude via cloud wants to start an Edit space in theodore on Studio',
    );
    const at = new Date(2026, 10, 19, 18, 5, 30).getTime();
    expect(confirmDeadline(at)).toBe('Unanswered by 18:05, it is refused');
  });
});

describe('auto mode', () => {
  const now = new Date(2026, 10, 19, 14, 30, 0, 0).getTime();

  it('turns a duration into until_ms', () => {
    expect(autoUntil('hour', now)).toBe(now + 3_600_000);
    expect(autoUntil('day', now)).toBe(
      new Date(2026, 10, 19, 23, 59, 59, 999).getTime(),
    );
    expect(autoUntil('forever', now)).toBeNull();
  });

  it('says how long it stays on', () => {
    expect(autoExpiry('off', null, now)).toBe('');
    expect(autoExpiry('edit', null, now)).toBe('until turned off');
    expect(
      autoExpiry('full', new Date(2026, 10, 19, 18, 0).getTime(), now),
    ).toBe('until 18:00');
    expect(
      autoExpiry('edit', new Date(2026, 10, 21, 9, 0).getTime(), now),
    ).toBe('until Nov 21, 09:00');
  });

  it('warns about the cloud holding the key, run only for full', () => {
    expect(autoWarning('off')).toBeNull();
    expect(autoWarning('edit')).toBe(
      'Its key is held by the Theodore cloud: with auto on, the cloud could make this computer edit without you.',
    );
    expect(autoWarning('full')).toBe(
      'Its key is held by the Theodore cloud: with auto on, the cloud could make this computer edit and run commands without you.',
    );
  });
});
