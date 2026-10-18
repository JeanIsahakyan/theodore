---
name: tests
description: Check whether this change is adequately tested — missing cases, assertions that don't test the right thing, tests that can't fail.
---

Review this pull request's tests, not its production code.

Focus on:
- Coverage: a new branch, error path, or edge case (empty input, zero,
  negative, max size, concurrent call) added in this diff with no
  corresponding test.
- Assertions: a test that runs the code but doesn't assert on the behavior
  that matters, or asserts on something trivially true regardless of a bug.
- Tests that can't fail: a mock or fixture that makes the assertion
  vacuous, a test that would pass even if the change were reverted.
- Flakiness: a test depending on real time, ordering, or external network
  without a seam to control it.
- Missing regression test: a bug fix in this diff with no test that would
  have caught the original bug.

Do not ask for tests on generated code, pure formatting changes, or comments.
For each issue, report the file, the line on the new side, a severity
(`info`, `warn`, or `high`), a short title, and a one- or two-sentence body
naming the specific case that's uncovered or the specific assertion that's
weak.
