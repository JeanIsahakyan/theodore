# shellcheck shell=bash
# Live click-testing (docs/live-qa.md). Source it, with a run dir of your own:
#
#   export QA=/tmp/theodore-qa/run1; . scripts/qa/kit.sh
#   start_sandbox; q 'return text()'; stop_app
#
# A live run also needs THEODORE_QA_REPO=<owner/name>: the only repo it may
# write to. Build first: scripts/qa/build.sh.

QA=${QA:-/tmp/theodore-qa/run}
THEODORE_QA_APP=${THEODORE_QA_APP:-/tmp/theodore-qa/app}
QA_KIT=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
QA_BIN=$THEODORE_QA_APP/Theodore.app/Contents/MacOS/theodore-app
export QA THEODORE_QA_APP
# The agents' MCP server runs the CLI.
export THEODORE_CLI=$THEODORE_QA_APP/theodore

_qa_die() { echo "✗ $*" >&2; return 1; }

_qa_check_dir() {
  case "$QA" in
    "$HOME"/.theodore*) _qa_die "QA=$QA is Theodore's own data; use a run dir of your own" ;;
    /*) ;;
    *) _qa_die "QA must be an absolute path: $QA" ;;
  esac
}

_qa_check_repo() {
  if ! printf %s "${THEODORE_QA_REPO:-}" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    _qa_die "THEODORE_QA_REPO=<owner/name> is required: the only repo a live run may write to"
  fi
}

# Starts the app on this run's own data dir; waits for the driver's window file.
# Arguments: extra VAR=value for the app.
_qa_launch() {
  _qa_check_dir || return 1
  [ -x "$QA_BIN" ] || { _qa_die "no build at $QA_BIN: run scripts/qa/build.sh"; return 1; }
  if [ -s "$QA/pid" ] && kill -0 "$(cat "$QA/pid")" 2>/dev/null; then
    _qa_die "already running in $QA (stop_app first)"; return 1
  fi
  mkdir -p "$QA/driver"
  rm -f "$QA/driver/window"
  nohup env "$@" THEODORE_DATA_DIR="$QA/data" THEODORE_QA_DRIVER="$QA/driver" \
    "$QA_BIN" >>"$QA/app.log" 2>&1 &
  echo $! >"$QA/pid"
  local _
  for _ in $(seq 1 40); do
    [ -s "$QA/driver/window" ] && break
    sleep 1
  done
  [ -s "$QA/driver/window" ] || { _qa_die "no driver after 40 s, see $QA/app.log"; return 1; }
  sleep 4
}

# Run JS in the app; prints {"ok":…} or {"err":…}. Helpers: lib.js.
q() { "$QA_KIT/qa" "$QA/driver" "$1"; }

# Simulated host, no network and no tokens (docs/sandbox.md).
start_sandbox() {
  _qa_check_dir || return 1
  mkdir -p "$QA"
  if [ ! -d "$QA/sandbox" ]; then
    "$THEODORE_CLI" sandbox init "$QA/sandbox" >/dev/null || return 1
  fi
  _qa_launch THEODORE_SANDBOX="$QA/sandbox"
}

# Real GitHub. Refuses without THEODORE_QA_REPO, and stops the app if problem
# reports can't be pointed at that repo.
start_live() {
  _qa_check_repo || return 1
  _qa_check_dir || return 1
  mkdir -p "$QA"
  export THEODORE_QA_REPO
  _qa_launch || return 1
  local got
  got=$(q 'return await setReportRepo(QA_REPO)')
  if [ "$got" != "{\"ok\":\"$THEODORE_QA_REPO\"}" ]; then
    stop_app
    _qa_die "couldn't point report.github_repo at $THEODORE_QA_REPO: $got"
    return 1
  fi
}

stop_app() {
  [ -s "$QA/pid" ] || return 0
  local pid _
  pid=$(cat "$QA/pid")
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 10); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    _qa_die "pid $pid still running after 10 s"; return 1
  fi
  rm -f "$QA/driver/window" "$QA/pid"
}

# Captures the app's window by number: never raises it, never touches the
# frontmost app or the mouse. Fails if the Mac is really locked or asleep.
shot() {
  screencapture -x -o -l"$(cat "$QA/driver/window")" "$QA/$1.png" || return 1
  echo "$QA/$1.png"
}

# `gh`, scoped to THEODORE_QA_REPO: refuses anything it can't scope.
qa_gh() {
  _qa_check_repo || return 1
  case "$1" in
    pr | issue | run | release | label | workflow) gh "$@" -R "$THEODORE_QA_REPO" ;;
    api)
      case "${2#/}" in
        "repos/$THEODORE_QA_REPO" | "repos/$THEODORE_QA_REPO"/* | "repos/$THEODORE_QA_REPO"\?*) gh "$@" ;;
        *) _qa_die "qa_gh api: endpoint must be repos/$THEODORE_QA_REPO/…, as the first argument" ;;
      esac
      ;;
    *) _qa_die "qa_gh: can't scope \`gh $1\` to $THEODORE_QA_REPO" ;;
  esac
}
