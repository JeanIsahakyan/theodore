#!/bin/sh
# Fake agent CLI for process-lifecycle tests (crates/agents/tests/process.rs).
# Usage: fake_agent.sh <mode>
#   normal     - one line, exit 0
#   stall      - one line, sleep past the test's stall_after_ms, another line, exit 0
#   crash      - stderr output, exit 1, no stdout
#   hang       - sleep far longer than any test timeout, for cancellation tests
#   bigstderr  - >4KB of stderr ending in a known marker, then exit 1
#   bigline    - one stdout line far larger than the 1MB cap, no trailing newline, exit 0

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
  bigstderr)
    i=0
    while [ $i -lt 2000 ]; do
      printf '0123456789' 1>&2
      i=$((i + 1))
    done
    printf 'END' 1>&2
    exit 1
    ;;
  bigline)
    head -c 3000000 /dev/zero | tr '\0' 'a'
    exit 0
    ;;
  *)
    echo "unknown mode: $mode" 1>&2
    exit 2
    ;;
esac
