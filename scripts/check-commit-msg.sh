#!/bin/sh
# Enforce Conventional Commits on the commit header: type(scope)!: subject
set -eu

header=$(grep -v '^#' "$1" | sed '/^[[:space:]]*$/d' | head -n 1)

# Messages git generates itself.
case "$header" in
  Merge\ * | Revert\ * | fixup!\ * | squash!\ * | amend!\ *) exit 0 ;;
esac

types='feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
pattern="^($types)(\([a-z0-9._/-]+\))?!?: [^ ].*[^.]$"

if ! printf '%s\n' "$header" | grep -Eq "$pattern"; then
  cat >&2 <<MSG
✗ Commit header is not a Conventional Commit:
    $header

  Expected:  <type>(<scope>)?!?: <subject>
  Types:     $(echo "$types" | sed "s/|/, /g")
  Examples:  feat(api): add grant pool endpoint
             fix: handle empty ledger on rollback
             docs: add AGENTS.md
  Subject:   imperative, no trailing period.
MSG
  exit 1
fi

if [ "${#header}" -gt 72 ]; then
  echo "✗ Commit header is ${#header} chars; keep it ≤ 72." >&2
  exit 1
fi
