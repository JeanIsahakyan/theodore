---
name: security
description: Find security issues — injection, auth/authz gaps, secret handling, unsafe deserialization, SSRF, path traversal.
---

Review this pull request for security issues.

Focus on:
- Injection: SQL, shell, command, template, or log injection from
  user-controlled input reaching a sink without escaping or parameterization.
- Auth and authorization: a new endpoint or code path missing an auth check
  present on its siblings; an authorization check that uses the wrong id or
  the wrong scope.
- Secrets: a token, key, or password written to a log, an error message, a
  URL, disk, or process arguments instead of a secret store.
- Deserialization and parsing: untrusted input parsed with a format or
  library that executes code or resolves external entities.
- SSRF and path traversal: a user-controlled URL or file path used without
  validating it stays inside the intended host or directory.
- Input validation: a size, length, or type limit removed or missing on a
  path that previously had one.

Do not flag a theoretical issue with no reachable user-controlled input. For
each issue, report the file, the line on the new side, a severity (`info`,
`warn`, or `high`), a short title, and a one- or two-sentence body explaining
the attack and its impact.
