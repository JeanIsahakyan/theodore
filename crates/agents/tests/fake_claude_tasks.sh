#!/bin/bash
# Fake `claude -p --input-format stream-json` with one background task, for
# process tests (crates/agents/tests/process.rs). The shapes are the recorded
# ones (fixtures/claude_background_tasks.jsonl). `$1` says how it goes after
# the first turn's result (a task t1 running):
#   stop     waits for a stop_task control_request, answers it
#   natural  t1 ends by itself, the CLI takes the turn up (origin), answers
#   hang     waits forever (the linger cap ends it)
#   message  answers each user message read after the first, t1 keeps running
#   crash    the process dies with t1 running
mode="${1:-stop}"

IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"S"}'
echo "${first%\}},\"isReplay\":true}"
echo '{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"t1","task_type":"local_bash","description":"sleep 300"}]}'
echo '{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"call1","description":"sleep 300","is_backgrounded":true,"task_type":"local_bash"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"STARTED","session_id":"S"}'
echo '{"type":"system","subtype":"session_state_changed","state":"idle"}'

case "$mode" in
  stop)
    while IFS= read -r line; do
      case "$line" in
        *control_request*)
          id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
          echo '{"type":"system","subtype":"task_updated","task_id":"t1","patch":{"status":"killed","end_time":2}}'
          echo '{"type":"system","subtype":"task_notification","task_id":"t1","tool_use_id":"call1","status":"stopped","output_file":"/tmp/x.output","summary":"sleep 300"}'
          echo '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'
          echo "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$id\",\"response\":{}}}"
          echo '{"type":"system","subtype":"session_state_changed","state":"idle"}'
          ;;
      esac
    done
    exit 0
    ;;
  natural)
    sleep 1
    echo '{"type":"system","subtype":"task_updated","task_id":"t1","patch":{"status":"completed","end_time":2}}'
    echo '{"type":"system","subtype":"task_notification","task_id":"t1","tool_use_id":"call1","status":"completed","output_file":"/tmp/x.output","summary":"done"}'
    echo '{"type":"system","subtype":"background_tasks_changed","tasks":[]}'
    echo '{"type":"system","subtype":"session_state_changed","state":"running"}'
    echo '{"type":"system","subtype":"init","session_id":"S"}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"it finished","session_id":"S","origin":{"kind":"task-notification"}}'
    echo '{"type":"system","subtype":"session_state_changed","state":"idle"}'
    # stdin closes once the set is empty and no reply is expected.
    cat > /dev/null
    exit 0
    ;;
  hang)
    cat > /dev/null
    exit 0
    ;;
  message)
    while IFS= read -r line; do
      echo "${line%\}},\"isReplay\":true}"
      echo '{"type":"system","subtype":"session_state_changed","state":"running"}'
      echo '{"type":"result","subtype":"success","is_error":false,"result":"second answer","session_id":"S"}'
      echo '{"type":"system","subtype":"session_state_changed","state":"idle"}'
    done
    exit 0
    ;;
  crash)
    sleep 1
    exit 3
    ;;
esac
