import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RestartReason, Space } from '../../gen/contract';
import { SpaceResuming, resumingText } from './SpaceResuming';

const space = (over: Partial<Space>): Space => ({
  id: 's1',
  project: 'local:app',
  name: 's1',
  goal: '',
  branch: 'theo/s1',
  base: 'main',
  base_sha: 'b',
  head_sha: 'h',
  worktree: '/tmp/s1',
  status: 'idle',
  agent: 'claude',
  model: null,
  mode: 'edit',
  review_pr: null,
  pr: null,
  turns: 1,
  run: null,
  error: null,
  created_at: 0,
  updated_at: 0,
  ...over,
});

const pause = (reason: RestartReason) => ({
  run: 'space:s1:m1',
  message: 'm1',
  agent: 'claude' as const,
  model: null,
  effort: null,
  mode: 'edit' as const,
  session: null,
  reason,
  at: 1,
  killed: false,
});

describe('SpaceResuming', () => {
  it('says the turn is paused until the restart resumes it', () => {
    const html = renderToStaticMarkup(
      <SpaceResuming
        space={space({
          restart_pause: pause({ kind: 'update', version: '0.2.0' }),
        })}
      />,
    );
    expect(html).toContain('Paused for update · resuming…');
    expect(resumingText({ kind: 'quit' })).toBe('Paused for restart · resuming…');
  });

  it('shows nothing once the turn runs again, or without a pause', () => {
    expect(
      renderToStaticMarkup(
        <SpaceResuming
          space={space({
            status: 'running',
            restart_pause: pause({ kind: 'quit' }),
          })}
        />,
      ),
    ).toBe('');
    expect(renderToStaticMarkup(<SpaceResuming space={space({})} />)).toBe('');
  });
});
