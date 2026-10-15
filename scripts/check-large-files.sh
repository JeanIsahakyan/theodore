#!/bin/sh
# Block accidentally staged large files (build output, dumps, binaries).
set -eu

limit_kb=${MAX_FILE_KB:-1024}
status=0

for f in "$@"; do
  [ -f "$f" ] || continue
  size_kb=$(( $(wc -c < "$f") / 1024 ))
  if [ "$size_kb" -gt "$limit_kb" ]; then
    echo "✗ $f is ${size_kb} KB (limit ${limit_kb} KB). Set MAX_FILE_KB to override." >&2
    status=1
  fi
done

exit $status
