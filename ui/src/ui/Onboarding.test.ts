import { describe, expect, it } from 'vitest';
import { onboardingSteps, skippable } from './Onboarding';

describe('onboardingSteps', () => {
  it('starts with the sign-in when it is required', () => {
    expect(onboardingSteps(true)).toEqual([
      'account',
      'theme',
      'github',
      'agents',
      'projects',
      'done',
    ]);
  });

  it('leaves it out when the account feature is hidden', () => {
    expect(onboardingSteps(false)).toEqual([
      'theme',
      'github',
      'agents',
      'projects',
      'done',
    ]);
  });
});

describe('onboardingSteps with a sharing choice', () => {
  it('puts it right after the sign-in', () => {
    expect(onboardingSteps(true, true)).toEqual([
      'account',
      'telemetry',
      'theme',
      'github',
      'agents',
      'projects',
      'done',
    ]);
  });

  it('puts it first without a sign-in', () => {
    expect(onboardingSteps(false, true)[0]).toBe('telemetry');
  });

  it('leaves it out when the build has nowhere to send', () => {
    expect(onboardingSteps(true, false)).not.toContain('telemetry');
    expect(onboardingSteps(false, false)).not.toContain('telemetry');
  });
});

describe('skippable', () => {
  it('never lets the sign-in step be skipped', () => {
    expect(skippable('account', false)).toBe(false);
    expect(skippable('account', true)).toBe(false);
  });

  it('skips Projects only while none is added', () => {
    expect(skippable('projects', false)).toBe(true);
    expect(skippable('projects', true)).toBe(false);
    expect(skippable('github', false)).toBe(false);
  });
});
