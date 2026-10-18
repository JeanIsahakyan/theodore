---
name: bugs
description: Find correctness bugs introduced by this change — logic errors, off-by-one, nil/None handling, race conditions, wrong error handling.
---

Review this pull request for correctness bugs, not style.

Focus on:
- Logic errors: wrong condition, inverted boolean, off-by-one, wrong operator.
- Null/None/undefined handling: a value that can be absent but is used as if
  it can't.
- Error handling: a swallowed error, an error path that leaves state
  inconsistent, a `?`/`try` that should have been handled locally.
- Concurrency: a shared mutable value touched without the lock/guard that
  protects it elsewhere, a race between two async operations.
- Resource lifetime: something opened/locked/spawned that isn't closed,
  unlocked, or joined on every path, including early returns and errors.
- Boundary conditions: empty collections, zero, negative numbers, the first
  and last element of a loop.

Do not flag style, naming, or formatting. Do not propose a fix unless asked.
For each issue, report the file, the line on the new side, a severity
(`info`, `warn`, or `high`), a short title, and a one- or two-sentence body
explaining what goes wrong and when.
