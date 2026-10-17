#!/bin/sh
# Fake agent CLI for process-lifecycle tests (crates/agents/tests/process.rs).
# Usage: fake_agent.sh <mode>
#   normal  - one line, exit 0
#   stall   - one line, sleep past the test's stall_after_ms, another line, exit 0
#   crash   - stderr output, exit 1, no stdout
#   hang    - sleep far longer than any test timeout, for cancellation tests

mode="${1:-normal}"

case "$mode" in
  normal)
    echo '{"line":1}'
    exit 0
    ;;
  stall)
    echo '{"line":1}'
    sleep 1
    echo '{"line":2}'
    exit 0
    ;;
  crash)
    echo "fake agent: something broke" 1>&2
    exit 1
    ;;
  hang)
    sleep 60
    exit 0
    ;;
  *)
    echo "unknown mode: $mode" 1>&2
    exit 2
    ;;
esac
