#!/usr/bin/env bash
set -Eeuo pipefail

step="initialize smoke check"
trap 'status=$?; printf "pass17 smoke: failed: %s\n" "$step" >&2; exit "$status"' ERR

step="governed-delivery evidence exists"
test -f qa/smoke/pass17-governed-delivery.md

step="task evidence exists"
test -f qa/smoke/VIB-1.md

step="task evidence identifies the smoke check"
grep -q '^# Governed-delivery smoke check$' qa/smoke/VIB-1.md

printf '%s\n' "pass17 smoke: ok"
