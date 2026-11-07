#!/usr/bin/env bash
# A fake lease tool for the bench tests: take writes $LEASE_DIR/RESOURCE/info, renew does nothing, release removes
# the folder. Each call is logged to $LEASE_DIR/calls.log.
set -euo pipefail
action="$1" res="$2" thread="$3"
mkdir -p "$LEASE_DIR"
printf '%s %s %s %s\n' "$action" "$res" "$thread" "${4:-}" >>"$LEASE_DIR/calls.log"
case "$action" in
take)
	mkdir "$LEASE_DIR/$res"
	printf 'resource=%s\nthread=%s\nnote=%s\n' "$res" "$thread" "${4:-}" >"$LEASE_DIR/$res/info"
	;;
renew) ;;
release) rm -rf -- "${LEASE_DIR:?}/$res" ;;
esac
