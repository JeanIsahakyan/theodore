import { describe, expect, it } from 'vitest';
import { onboardingSteps } from './Onboarding';

describe('onboardingSteps', () => {
  it('starts with the optional sign-in when it is configured', () => {
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
