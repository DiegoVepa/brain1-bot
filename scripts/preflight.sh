#!/bin/bash
# preflight.sh — Browser automation health checks for LinkedIn cron jobs
# Usage: preflight.sh [--quiet] [--skip-telegram]
#   --quiet         Suppress Telegram test ping (use in cron pre-steps)
#   --skip-telegram Skip Telegram check entirely
# Exit 0 = all pass, Exit 1 = critical failure
# Output: JSON report to stdout

set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SNAPSHOT_FILE="/tmp/preflight-snapshot-$(date +%s).yaml"
SHEETS_ID="1Pu-X7r1mhySxdLn-IMVEosVaDR5OPzBU53xev3I95Xw"
START_EPOCH=$(date +%s)

# Parse flags
QUIET=false
SKIP_TELEGRAM=false
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET=true ;;
    --skip-telegram) SKIP_TELEGRAM=true ;;
  esac
done

# Result accumulators
declare -a FAILED_CHECKS=()
declare -a ADVISORY_CHECKS=()
PW_STATUS="skip"
PW_DETAIL=""
LI_STATUS="skip"
LI_DETAIL=""
LI_RECOVERY=""
GWS_STATUS="skip"
GWS_DETAIL=""
GWS_RECOVERY=""
TG_STATUS="skip"
TG_DETAIL=""

# --- Helper: run command with timeout (macOS compatible) ---
run_with_timeout() {
  local timeout_secs=$1
  shift
  "$@" &
  local PID=$!
  ( sleep "$timeout_secs" && kill "$PID" 2>/dev/null ) &
  local WATCHDOG=$!
  wait "$PID" 2>/dev/null
  local RESULT=$?
  kill "$WATCHDOG" 2>/dev/null 2>&1
  wait "$WATCHDOG" 2>/dev/null 2>&1
  return $RESULT
}

# ============================================================
# CHECK 1: playwright-cli binary
# ============================================================
PW_PATH=$(which playwright-cli 2>/dev/null)
if [ -n "$PW_PATH" ]; then
  PW_STATUS="pass"
  PW_DETAIL="$PW_PATH"
else
  PW_STATUS="fail"
  PW_DETAIL="playwright-cli not found on PATH"
  FAILED_CHECKS+=("playwright_binary")
fi

# ============================================================
# CHECK 2: LinkedIn session auth
# ============================================================
if [ "$PW_STATUS" = "pass" ]; then
  # Open persistent session and navigate to feed
  run_with_timeout 20 playwright-cli -s=linkedin goto "https://www.linkedin.com/feed/" > /dev/null 2>&1
  GOTO_EXIT=$?

  if [ $GOTO_EXIT -ne 0 ]; then
    LI_STATUS="fail"
    LI_DETAIL="Failed to navigate to LinkedIn feed (exit code $GOTO_EXIT)"
    LI_RECOVERY="Run: playwright-cli -s=linkedin open https://linkedin.com/login --browser=chrome --persistent --headed"
    FAILED_CHECKS+=("linkedin_session")
  else
    # Take snapshot and check for login redirect
    run_with_timeout 15 playwright-cli -s=linkedin snapshot > "$SNAPSHOT_FILE" 2>/dev/null
    SNAP_EXIT=$?

    if [ $SNAP_EXIT -ne 0 ]; then
      LI_STATUS="fail"
      LI_DETAIL="Snapshot failed (exit code $SNAP_EXIT)"
      LI_RECOVERY="Run: playwright-cli -s=linkedin open https://linkedin.com/login --browser=chrome --persistent --headed"
      FAILED_CHECKS+=("linkedin_session")
    else
      # Check if we got redirected to login page
      if grep -qiE '(sign.in|login|session_redirect|auth_wall)' "$SNAPSHOT_FILE" 2>/dev/null && \
         ! grep -qiE '(Start a post|Messaging|Notifications)' "$SNAPSHOT_FILE" 2>/dev/null; then
        LI_STATUS="fail"
        LI_DETAIL="Redirected to login page — session expired"
        LI_RECOVERY="Run: playwright-cli -s=linkedin open https://linkedin.com/login --browser=chrome --persistent --headed"
        FAILED_CHECKS+=("linkedin_session")
      else
        LI_STATUS="pass"
        LI_DETAIL="Feed loaded, authenticated"
      fi
    fi
  fi

  # Clean up snapshot file
  rm -f "$SNAPSHOT_FILE" 2>/dev/null
else
  LI_STATUS="skip"
  LI_DETAIL="Skipped — playwright-cli not available"
  LI_RECOVERY=""
fi

# ============================================================
# CHECK 3: Google Workspace Sheets API
# ============================================================
GWS_OUTPUT=$(run_with_timeout 15 gws sheets spreadsheets get --params "{\"spreadsheetId\":\"$SHEETS_ID\"}" 2>&1)

# gws returns exit 0 even on errors — check output content instead
if echo "$GWS_OUTPUT" | grep -q '"properties"'; then
  GWS_STATUS="pass"
  GWS_DETAIL="Spreadsheet accessible"
elif echo "$GWS_OUTPUT" | grep -qiE '(auth|token|credential|401|403|UNAUTHENTICATED)'; then
  GWS_STATUS="warn"
  GWS_DETAIL="Auth expired or invalid credentials"
  GWS_RECOVERY="Run: gws auth login"
  ADVISORY_CHECKS+=("gws_sheets")
else
  GWS_STATUS="warn"
  GWS_DETAIL="Sheets API error: $(echo "$GWS_OUTPUT" | head -1 | cut -c1-100)"
  GWS_RECOVERY="Check gws CLI: gws sheets spreadsheets get --params '{\"spreadsheetId\":\"$SHEETS_ID\"}'"
  ADVISORY_CHECKS+=("gws_sheets")
fi

# ============================================================
# CHECK 4: Telegram notification
# ============================================================
if [ "$SKIP_TELEGRAM" = "true" ]; then
  TG_STATUS="skip"
  TG_DETAIL="Skipped via --skip-telegram flag"
elif [ "$QUIET" = "true" ]; then
  # In quiet mode, just verify notify.sh exists and .env has tokens
  if [ -f "$SCRIPT_DIR/notify.sh" ]; then
    ENV_FILE="$SCRIPT_DIR/../.env"
    if [ -f "$ENV_FILE" ] && grep -q 'TELEGRAM_BOT_TOKEN' "$ENV_FILE" && grep -q 'ALLOWED_CHAT_ID' "$ENV_FILE"; then
      TG_STATUS="pass"
      TG_DETAIL="notify.sh and .env credentials present (dry check)"
    else
      TG_STATUS="fail"
      TG_DETAIL="Missing TELEGRAM_BOT_TOKEN or ALLOWED_CHAT_ID in .env"
      FAILED_CHECKS+=("telegram_notify")
    fi
  else
    TG_STATUS="fail"
    TG_DETAIL="notify.sh not found at $SCRIPT_DIR/notify.sh"
    FAILED_CHECKS+=("telegram_notify")
  fi
else
  # Live test: send a ping
  bash "$SCRIPT_DIR/notify.sh" "Preflight check: systems nominal" 2>/dev/null
  TG_EXIT=$?
  if [ $TG_EXIT -eq 0 ]; then
    TG_STATUS="pass"
    TG_DETAIL="Test message sent"
  else
    TG_STATUS="fail"
    TG_DETAIL="notify.sh failed (exit code $TG_EXIT)"
    FAILED_CHECKS+=("telegram_notify")
  fi
fi

# ============================================================
# BUILD JSON OUTPUT
# ============================================================
END_EPOCH=$(date +%s)
DURATION=$((END_EPOCH - START_EPOCH))
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ ${#FAILED_CHECKS[@]} -eq 0 ]; then
  OVERALL="pass"
else
  OVERALL="fail"
fi

HAS_WARNINGS=false
if [ ${#ADVISORY_CHECKS[@]} -gt 0 ]; then
  HAS_WARNINGS=true
fi

# Build JSON arrays
build_json_array() {
  local arr=("$@")
  if [ ${#arr[@]} -eq 0 ]; then
    echo "[]"
    return
  fi
  local json="["
  for i in "${!arr[@]}"; do
    [ $i -gt 0 ] && json+=","
    json+="\"${arr[$i]}\""
  done
  json+="]"
  echo "$json"
}

CRITICAL_JSON=$(build_json_array "${FAILED_CHECKS[@]}")
ADVISORY_JSON=$(build_json_array "${ADVISORY_CHECKS[@]}")

# "failed" = union of both for backward compat
ALL_FAILED=("${FAILED_CHECKS[@]}" "${ADVISORY_CHECKS[@]}")
FAILED_JSON=$(build_json_array "${ALL_FAILED[@]}")

# Escape double quotes in details
esc() { echo "$1" | sed 's/"/\\"/g'; }

cat <<EOF
{
  "timestamp": "$TIMESTAMP",
  "overall": "$OVERALL",
  "has_warnings": $HAS_WARNINGS,
  "duration_seconds": $DURATION,
  "checks": {
    "playwright_binary": { "status": "$PW_STATUS", "detail": "$(esc "$PW_DETAIL")" },
    "linkedin_session": { "status": "$LI_STATUS", "detail": "$(esc "$LI_DETAIL")"$([ -n "$LI_RECOVERY" ] && echo ", \"recovery\": \"$(esc "$LI_RECOVERY")\"") },
    "gws_sheets": { "status": "$GWS_STATUS", "detail": "$(esc "$GWS_DETAIL")"$([ -n "$GWS_RECOVERY" ] && echo ", \"recovery\": \"$(esc "$GWS_RECOVERY")\"") },
    "telegram_notify": { "status": "$TG_STATUS", "detail": "$(esc "$TG_DETAIL")" }
  },
  "critical_failed": $CRITICAL_JSON,
  "advisory_failed": $ADVISORY_JSON,
  "failed": $FAILED_JSON
}
EOF

# Exit with appropriate code
if [ "$OVERALL" = "fail" ]; then
  exit 1
else
  exit 0
fi
