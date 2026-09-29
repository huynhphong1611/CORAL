#!/usr/bin/env bash
# 🔌 Phase 1 device checks on an Android emulator (.github/workflows/device.yml): T039, T041, T056,
# T060, T063. Every check runs even when an earlier one fails; logs, a summary and the evidence
# (screenshots, trees, device logs) go to $CORAL_DEVICE_OUT.
#
# Needs: adb with exactly one device online, CORAL_TEST_APK (My Demo App), docker compose services
# up and migrated, CORAL_SECRET_TEST_USER / CORAL_SECRET_TEST_PASSWORD in the environment.
set -uo pipefail

OUT=$(realpath -m "${CORAL_DEVICE_OUT:-device-results}")
APP=com.saucelabs.mydemoapp.android
APK=$(realpath "${CORAL_TEST_APK:?set CORAL_TEST_APK to the My Demo App APK}")
SERVER=http://localhost:3000
LOGIN=fixtures/testcases/mydemo-login.yaml
CAMERA=fixtures/testcases/mydemo-camera-permission.yaml
: "${CORAL_SECRET_TEST_USER:?}" "${CORAL_SECRET_TEST_PASSWORD:?}"
export CORAL_SEED_EMAIL=ci@coral.test
CORAL_SEED_PASSWORD="ci-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
export CORAL_SEED_PASSWORD CORAL_SERVER_URL=$SERVER
mkdir -p "$OUT"
printf '| task | check | result |\n|---|---|---|\n' >"$OUT/summary.md"

failed=0
# check <task> <title> <command...>: runs the command, keeps its output in $OUT/<task>.log.
check() {
  local task=$1 title=$2
  shift 2
  echo "::group::$task — $title"
  "$@" 2>&1 | tee "$OUT/$task.log"
  local rc=${PIPESTATUS[0]}
  echo "::endgroup::"
  if [ "$rc" -eq 0 ]; then
    echo "| $task | $title | ✅ |" >>"$OUT/summary.md"
  else
    echo "| $task | $title | ❌ exit $rc |" >>"$OUT/summary.md"
    echo "::error title=$task::$title failed (exit $rc)"
    failed=1
  fi
}

adb devices -l | tee "$OUT/devices.txt"
adb shell getprop ro.build.version.release | sed 's/^/android /' | tee -a "$OUT/devices.txt"

# Local runs without the server (US2).
check T039 'driver + coral run device tests (pnpm test:device)' \
  env CORAL_TEST_APK="$APK" pnpm test:device
check T041 'coral run mydemo-login' \
  pnpm -s coral run "$LOGIN" --app "$APP" --apk "$APK" --out "$OUT/coral-run"
check T060-local 'coral run mydemo-camera-permission (popup guard)' \
  pnpm -s coral run "$CAMERA" --app "$APP" --out "$OUT/coral-run"

# Through the server (US3–US5): server + agent in the background, then the DoD script.
pnpm -s --filter @coral/server db:seed
(cd apps/server && CORAL_LOG_LEVEL=debug exec node --import tsx src/main.ts) >"$OUT/server.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 60); do curl -sf "$SERVER/health/ready" >/dev/null && break; sleep 1; done
token=$(curl -sf "$SERVER/auth/login" -H 'content-type: application/json' \
  -d "{\"email\":\"$CORAL_SEED_EMAIL\",\"password\":\"$CORAL_SEED_PASSWORD\"}" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).access_token))')
agent_token=$(curl -sf "$SERVER/agents" -H "authorization: Bearer $token" \
  -H 'content-type: application/json' -d '{"name":"ci-emulator"}' |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).token))')
CORAL_AGENT_TOKEN=$agent_token CORAL_LOG_LEVEL=debug node --import tsx apps/agent/src/main.ts \
  >"$OUT/agent.log" 2>&1 &
agent_pid=$!

check T056 'server: mydemo-login 5/5, artifacts, secrets' \
  node scripts/phase1-e2e.mjs --apk "$APK" --testcase "$LOGIN" --runs 5 --scan-secrets \
  --download "$OUT/server-runs"
check T060 'server: camera permission 5/5 with android_permission' \
  node scripts/phase1-e2e.mjs --apk "$APK" --testcase "$CAMERA" --runs 5 \
  --expect-popup android_permission --download "$OUT/server-runs"
last_run=$(grep -oE 'run 5/5 [0-9a-f-]{36}' "$OUT/T056.log" | awk '{print $3}')
check T063 "scan run ${last_run:-?} for secrets" \
  node scripts/phase1-e2e.mjs --scan-secrets --run "${last_run:-missing}"

kill "$agent_pid" "$server_pid" 2>/dev/null
wait "$agent_pid" "$server_pid" 2>/dev/null
# SC-008 for the logs: neither secret value may appear in what the server and agent wrote.
count_secrets() {
  local hits=0
  for value in "$CORAL_SECRET_TEST_USER" "$CORAL_SECRET_TEST_PASSWORD"; do
    hits=$((hits + $(cat "$OUT/server.log" "$OUT/agent.log" "$OUT"/T*.log | grep -cF -- "$value")))
  done
  echo "secret values in server.log, agent.log and check logs: $hits"
  [ "$hits" -eq 0 ]
}
check T063-logs 'no secret value in server/agent logs' count_secrets

cat "$OUT/summary.md"
[ -n "${GITHUB_STEP_SUMMARY:-}" ] && cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
exit "$failed"
