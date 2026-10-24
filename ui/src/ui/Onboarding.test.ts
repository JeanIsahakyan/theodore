import { describe, expect, it } from 'vitest';
import { onboardingSteps, skippable } from './Onboarding';

describe('onboardingSteps', () => {
  it('starts with the sign-in when it is required', () => {
    expect(onboardingSteps(true)).toEqual([
      'account',
      'github',
      'agents',
      'projects',
      'done',
    ]);
  });

  it('leaves it out when the account feature is hidden', () => {
    expect(onboardingSteps(false)).toEqual([
      'github',
      'agents',
      'projects',
      'done',
    ]);
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
