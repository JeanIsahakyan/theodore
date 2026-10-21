import { describe, expect, it } from 'vitest';
import { onboardingSteps } from './Onboarding';

describe('onboardingSteps', () => {
  it('adds the optional account step right after GitHub when configured', () => {
    expect(onboardingSteps(true)).toEqual([
      'github',
      'account',
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
