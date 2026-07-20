#!/bin/sh
#
# deploy-pi.sh — the ONLY sanctioned way to restart the MatchTime bot.
#
# ── Why this exists ───────────────────────────────────────────────────
# 2026-07-19: a customer's WhatsApp group received 30+ copies of the same
# roster message in ~20 minutes. Root cause was duplicate bot processes on
# the Pi. Repeated `sudo systemctl restart matchtime-bot.service` had left
# node processes running OUTSIDE systemd's cgroup — we confirmed two
# separate `sh -c node --env-file … src/index.ts` process trees while
# systemd's MainPID tracked only one. Every orphan was logged into the
# same WhatsApp account and every one polled /api/whatsapp/due-posts on a
# 30s timer, so each of them sent the same due message.
#
# `systemctl restart` alone CANNOT fix this: it only stops what it owns.
# This script stops the unit, then kills orphans by PROCESS PATTERN
# (cgroup membership is exactly what the orphans escaped), verifies zero
# remain, starts the unit ONCE, and verifies EXACTLY ONE instance is
# running. Anything other than 1 is a hard failure with a non-zero exit.
#
# ── Usage ─────────────────────────────────────────────────────────────
#   On the Pi:      sudo sh ~/matchtime-bot/scripts/deploy-pi.sh
#   From a laptop:  ssh davidediz@matchtime-pi.tail1437f5.ts.net \
#                     'cd ~/matchtime-bot && git pull --ff-only && \
#                      cd whatsapp-bot && npm install --silent && cd .. && \
#                      sudo sh scripts/deploy-pi.sh'
#
# ── Dry-run (used by src/lib/__tests__/deploy-pi.test.ts) ─────────────
#   MT_DEPLOY_DRY_RUN=1 MT_DEPLOY_FAKE_COUNT=3 sh scripts/deploy-pi.sh
# stubs every privileged action and forces the instance count, so the
# failure path is verifiable without a Raspberry Pi.

set -eu

SERVICE="${MT_SERVICE:-matchtime-bot.service}"

# How we count instances
# ----------------------
# `npm start` runs `node --env-file=.env --import tsx src/index.ts`, and npm
# wraps that in `sh -c`. So there is exactly ONE `sh -c node --env-file …
# src/index.ts` wrapper per running bot — that is the reliable unit to
# count. We do NOT count `node` processes (tsx/puppeteer spawn several per
# bot) and we do NOT count via systemd's cgroup/MainPID: orphans escape
# the cgroup, which is the entire failure mode we are defending against.
#
# NB the trap that bit us during diagnosis: a naive
#   pgrep -f "sh -c node --env-file"
# ALSO matches the shell running this very script, because that pattern
# appears in this script's own command line / ancestry. We exclude our own
# PID ($$) and our parent, and use `pgrep -f` with an explicit exclusion so
# the count can never include the invoking shell. (pgrep_exclude_self)
PATTERN="${MT_BOT_PATTERN:-sh -c node --env-file.*src/index.ts}"

count_instances() {
  if [ "${MT_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    echo "${MT_DEPLOY_FAKE_COUNT:-1}"
    return 0
  fi
  # pgrep_exclude_self: drop our own pid and our parent's pid from the
  # match set before counting.
  pgrep -f "$PATTERN" 2>/dev/null \
    | grep -v -x -e "$$" -e "$PPID" \
    | wc -l \
    | tr -d ' '
}

list_instances() {
  if [ "${MT_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    return 0
  fi
  pgrep -a -f "$PATTERN" 2>/dev/null | grep -v -e "^$$ " -e "^$PPID " || true
}

run_priv() {
  if [ "${MT_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    echo "  [dry-run] would run: $*"
    return 0
  fi
  "$@"
}

nap() {
  if [ "${MT_DEPLOY_DRY_RUN:-0}" = "1" ]; then
    return 0
  fi
  sleep "$1"
}

echo "==> MatchTime bot deploy/restart ($SERVICE)"

# ── 1. Stop the unit ──────────────────────────────────────────────────
echo "--> stopping $SERVICE"
run_priv systemctl stop "$SERVICE" || true
nap 5

# ── 2. Kill anything left, by pattern (orphans are outside the cgroup) ─
REMAINING=$(count_instances)
if [ "$REMAINING" != "0" ] && [ "${MT_DEPLOY_DRY_RUN:-0}" != "1" ]; then
  echo "--> $REMAINING orphan instance(s) survived the stop; killing by pattern"
  list_instances
  pkill -f "$PATTERN" 2>/dev/null || true
  nap 3
  if [ "$(count_instances)" != "0" ]; then
    echo "--> still alive; escalating to SIGKILL"
    pkill -9 -f "$PATTERN" 2>/dev/null || true
    nap 3
  fi
fi

# ── 3. Verify ZERO remain before we start a new one ───────────────────
if [ "${MT_DEPLOY_DRY_RUN:-0}" != "1" ]; then
  BEFORE=$(count_instances)
  if [ "$BEFORE" != "0" ]; then
    echo "ERROR: $BEFORE bot process(es) still running after stop+kill. Refusing to" >&2
    echo "       start another — that is exactly how the 2026-07-19 flood happened." >&2
    list_instances >&2
    exit 2
  fi
  echo "--> confirmed 0 instances running"
fi

# Stale lockfile from a SIGKILLed instance would self-heal anyway (the
# guard probes liveness), but clear it so startup logs stay clean.
run_priv rm -f "${MT_BOT_LOCK_PATH:-/tmp/matchtime-bot.pid}"

# ── 4. Start ONCE ─────────────────────────────────────────────────────
echo "--> starting $SERVICE"
run_priv systemctl start "$SERVICE"
nap 10

# ── 5. Verify EXACTLY ONE ─────────────────────────────────────────────
AFTER=$(count_instances)
if [ "$AFTER" != "1" ]; then
  echo "" >&2
  echo "########################################################" >&2
  echo "ERROR: expected exactly 1 bot instance, found $AFTER" >&2
  echo "########################################################" >&2
  if [ "$AFTER" = "0" ]; then
    echo "The service failed to start. Check:" >&2
    echo "  systemctl status $SERVICE --no-pager" >&2
    echo "  journalctl -u $SERVICE -n 100 --no-pager" >&2
  else
    echo "DUPLICATE INSTANCES — this is the 2026-07-19 flood condition." >&2
    echo "Kill them all and re-run this script:" >&2
    echo "  sudo pkill -9 -f '$PATTERN'" >&2
    list_instances >&2
  fi
  exit 1
fi

if [ "${MT_DEPLOY_DRY_RUN:-0}" = "1" ]; then
  echo "OK: exactly one instance running (dry-run)"
  exit 0
fi

PID=$(pgrep -f "$PATTERN" | grep -v -x -e "$$" -e "$PPID" | head -1)
echo "OK: exactly one instance running (pid $PID)"
systemctl is-active "$SERVICE" || true
exit 0
