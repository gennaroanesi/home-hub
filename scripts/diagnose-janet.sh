#!/usr/bin/env bash
# Diagnose the morning-summary / WA bot pipeline end-to-end.
#
# Two failure modes have shown up before:
#   1. dailySummary Lambda didn't fire (scheduler / Lambda error)
#   2. Lambda fired and queued a homeOutboundMessage but the WA bot
#      didn't pick it up (poller bug, stale WA session, etc.)
#
# This script walks the pipeline and prints a punch list so you don't
# have to dig through CloudWatch by hand every time.
#
# Usage:
#   scripts/diagnose-janet.sh [--profile <aws-profile>] [--days N] [--region <region>]
#
# Defaults:
#   --profile amplify-dev
#   --region  us-east-1
#   --days    1   (today only; UTC day boundaries)
#
# Requires: aws CLI, jq.

set -euo pipefail

PROFILE="amplify-dev"
REGION="us-east-1"
DAYS=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --days)    DAYS="$2";    shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

AWS=( aws --profile "$PROFILE" --region "$REGION" )

# Window in epoch ms: now back to now-DAYS (UTC).
NOW_MS=$(($(date +%s) * 1000))
WINDOW_MS=$((DAYS * 86400 * 1000))
START_MS=$((NOW_MS - WINDOW_MS))

green() { printf "\033[32m%s\033[0m" "$1"; }
red()   { printf "\033[31m%s\033[0m" "$1"; }
yel()   { printf "\033[33m%s\033[0m" "$1"; }
hdr()   { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }

iso() {
  # epoch ms → ISO local. Tolerate empty / "None" / non-numeric input.
  local ms="${1:-}"
  if [[ -z "$ms" || "$ms" == "null" || "$ms" == "None" ]] || ! [[ "$ms" =~ ^[0-9]+$ ]]; then
    echo "—"; return
  fi
  date -r "$((ms / 1000))" "+%Y-%m-%d %H:%M:%S %Z" 2>/dev/null \
    || date -d "@$((ms / 1000))" "+%Y-%m-%d %H:%M:%S %Z"
}

# ── Find the prod (main branch) dailySummary Lambda ──────────────────────────
hdr "Daily summary Lambda"

# list-functions paginates — JMESPath runs per page so we filter the
# stream and take the first hit rather than relying on `| [0]`.
LAMBDA_NAME=$("${AWS[@]}" lambda list-functions \
  --query "Functions[?contains(FunctionName, 'dkiwlyw3k1yfi-mai-dailysummary')].FunctionName" \
  --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' | head -1 || true)

if [[ -z "$LAMBDA_NAME" ]]; then
  red "✗ Could not locate main-branch dailySummary Lambda"; echo
  exit 1
fi
echo "Lambda: $LAMBDA_NAME"

LAMBDA_LOG_GROUP="/aws/lambda/$LAMBDA_NAME"

# Latest stream within window.
LAMBDA_STREAM=$("${AWS[@]}" logs describe-log-streams \
  --log-group-name "$LAMBDA_LOG_GROUP" \
  --order-by LastEventTime --descending --max-items 1 \
  --query "logStreams[0].logStreamName" --output text 2>/dev/null || true)

if [[ -z "$LAMBDA_STREAM" || "$LAMBDA_STREAM" == "None" ]]; then
  red "✗ No log streams"; echo
  exit 1
fi

# Did the Lambda fire in the window? Look for INIT_START or START
LAMBDA_FIRED=$("${AWS[@]}" logs filter-log-events \
  --log-group-name "$LAMBDA_LOG_GROUP" \
  --filter-pattern '"START RequestId"' \
  --start-time "$START_MS" \
  --query "events[*].timestamp" --output text 2>/dev/null | tr '\t' '\n' | tail -1 || true)

if [[ -n "$LAMBDA_FIRED" && "$LAMBDA_FIRED" != "None" ]]; then
  green "✓"; printf " Lambda fired at %s\n" "$(iso "$LAMBDA_FIRED")"
else
  red "✗"; echo " Lambda did NOT fire in the last $DAYS day(s)"
  echo "   → check EventBridge schedule 'dailySummarySchedule' (cron 0 12 * * ? *)"
fi

# Did it queue a message? Extract the message ID from log line.
# AWS CLI paginates filter-log-events and applies --query per page, so
# events[-1] yields one row per page. Grab the last non-empty line.
QUEUE_LINE=$("${AWS[@]}" logs filter-log-events \
  --log-group-name "$LAMBDA_LOG_GROUP" \
  --filter-pattern '"Outbound message queued"' \
  --start-time "$START_MS" \
  --query "events[*].[timestamp,message]" --output text 2>/dev/null \
  | grep -v '^None' | grep -v '^$' | tail -1 || true)

if [[ -z "$QUEUE_LINE" || "$QUEUE_LINE" == "None"$'\t'"None" ]]; then
  red "✗"; echo " Lambda did NOT queue an outbound message"
  echo "   → recent Lambda errors:"
  "${AWS[@]}" logs filter-log-events \
    --log-group-name "$LAMBDA_LOG_GROUP" \
    --filter-pattern 'ERROR' \
    --start-time "$START_MS" \
    --query "events[-5:].message" --output text 2>/dev/null | sed 's/^/      /' || true
  MSG_ID=""
else
  QUEUE_TS=$(echo "$QUEUE_LINE" | cut -f1)
  QUEUE_MSG=$(echo "$QUEUE_LINE" | cut -f2-)
  # The log line contains both the Lambda RequestId and the queued
  # message ID. The message ID always follows "queued:" so anchor on
  # that rather than the first UUID we find.
  MSG_ID=$(echo "$QUEUE_MSG" | grep -oE 'queued:[[:space:]]*[0-9a-f-]{36}' | tail -1 | grep -oE '[0-9a-f-]{36}' || true)
  green "✓"; printf " Queued message %s at %s\n" "$MSG_ID" "$(iso "$QUEUE_TS")"
fi

# ── WA bot ───────────────────────────────────────────────────────────────────
hdr "WA bot"

# There can be multiple bot log groups (one per ECS deployment). Pick
# the one with the most recent log activity.
BOT_LOG_GROUPS=$("${AWS[@]}" logs describe-log-groups \
  --query "logGroups[?contains(logGroupName, 'dkiwlyw3k1yfi-main') && contains(logGroupName, 'whatsappBot')].logGroupName" \
  --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' | grep -v '^$' || true)

BOT_LOG_GROUP=""
BEST_TS=0
while IFS= read -r lg; do
  [[ -z "$lg" ]] && continue
  # --max-items 1 still emits a pagination "None" trailer with
  # --output text. Extract the first numeric line only.
  ts=$("${AWS[@]}" logs describe-log-streams --log-group-name "$lg" \
    --order-by LastEventTime --descending --max-items 1 \
    --query "logStreams[0].lastEventTimestamp" --output text 2>/dev/null \
    | grep -E '^[0-9]+$' | head -1 || true)
  [[ -z "$ts" ]] && ts=0
  if [[ "$ts" -gt "$BEST_TS" ]]; then
    BEST_TS="$ts"
    BOT_LOG_GROUP="$lg"
  fi
done <<< "$BOT_LOG_GROUPS"

if [[ -z "$BOT_LOG_GROUP" ]]; then
  red "✗ Could not find WA bot log group"; echo
  exit 1
fi

# Pick the active stream (most recent event).
# Same pagination-trailer handling as above.
BOT_STREAM_INFO=$("${AWS[@]}" logs describe-log-streams \
  --log-group-name "$BOT_LOG_GROUP" \
  --order-by LastEventTime --descending --max-items 1 \
  --query "logStreams[0].[logStreamName,lastEventTimestamp]" --output text 2>/dev/null \
  | awk -F'\t' 'NF==2 && $2 ~ /^[0-9]+$/ { print; exit }' || true)
BOT_STREAM=$(echo "$BOT_STREAM_INFO" | cut -f1)
BOT_LAST_MS=$(echo "$BOT_STREAM_INFO" | cut -f2)

# Process alive? Cache refresh fires every 10 min; if last event is
# older than 15 min, the task is stuck or stopped.
if [[ -n "$BOT_LAST_MS" && "$BOT_LAST_MS" != "None" && "$BOT_LAST_MS" =~ ^[0-9]+$ ]]; then
  AGE_MIN=$(( (NOW_MS - BOT_LAST_MS) / 60000 ))
  if [[ $AGE_MIN -le 15 ]]; then
    green "✓"; printf " Bot process alive (last event %dm ago, %s)\n" "$AGE_MIN" "$(iso "$BOT_LAST_MS")"
  else
    red "✗"; printf " Bot stale (last event %dm ago, %s)\n" "$AGE_MIN" "$(iso "$BOT_LAST_MS")"
    echo "   → check ECS service desiredCount / task health"
  fi
else
  red "✗ No bot log stream"; echo
  exit 1
fi

# Was today's queued message delivered?
if [[ -n "$MSG_ID" ]]; then
  DELIVERED=$("${AWS[@]}" logs filter-log-events \
    --log-group-name "$BOT_LOG_GROUP" \
    --filter-pattern "\"$MSG_ID\"" \
    --start-time "$START_MS" \
    --query "events[*].[timestamp,message]" --output text 2>/dev/null || true)

  if echo "$DELIVERED" | grep -q "Outbound message sent"; then
    DELIVER_TS=$(echo "$DELIVERED" | grep "Outbound message sent" | tail -1 | cut -f1)
    green "✓"; printf " Bot delivered %s at %s\n" "$MSG_ID" "$(iso "$DELIVER_TS")"
  elif echo "$DELIVERED" | grep -qi "failed\|error"; then
    red "✗"; echo " Bot saw $MSG_ID but failed:"
    echo "$DELIVERED" | sed 's/^/      /' | head -10
  else
    red "✗"; printf " Bot never saw %s — poller didn't pick it up\n" "$MSG_ID"
    echo "   → likely a poller-side issue (query bug, AppSync auth, WA session)"
  fi
fi

# Backlog: any "Processing pending" or "Outbound poll failed" today?
PROCESSED=$("${AWS[@]}" logs filter-log-events \
  --log-group-name "$BOT_LOG_GROUP" \
  --filter-pattern '"Processing pending"' \
  --start-time "$START_MS" \
  --query "events[*].timestamp" --output text 2>/dev/null | tr '\t' '\n' | wc -l | tr -d ' ')

POLL_ERRORS=$("${AWS[@]}" logs filter-log-events \
  --log-group-name "$BOT_LOG_GROUP" \
  --filter-pattern '"Outbound poll failed"' \
  --start-time "$START_MS" \
  --query "events[*].timestamp" --output text 2>/dev/null | tr '\t' '\n' | wc -l | tr -d ' ')

DELIVERIES=$("${AWS[@]}" logs filter-log-events \
  --log-group-name "$BOT_LOG_GROUP" \
  --filter-pattern '"Outbound message sent"' \
  --start-time "$START_MS" \
  --query "events[*].timestamp" --output text 2>/dev/null | tr '\t' '\n' | wc -l | tr -d ' ')

printf "Poller activity in last %dd: %s polls hit, %s deliveries, %s errors\n" \
  "$DAYS" \
  "$([[ $PROCESSED -gt 0 ]] && green "$PROCESSED" || yel "$PROCESSED")" \
  "$([[ $DELIVERIES -gt 0 ]] && green "$DELIVERIES" || yel "$DELIVERIES")" \
  "$([[ $POLL_ERRORS -eq 0 ]] && green "$POLL_ERRORS" || red "$POLL_ERRORS")"

if [[ $POLL_ERRORS -gt 0 ]]; then
  echo "Recent poll errors:"
  "${AWS[@]}" logs filter-log-events \
    --log-group-name "$BOT_LOG_GROUP" \
    --filter-pattern '"Outbound poll failed"' \
    --start-time "$START_MS" \
    --query "events[-3:].message" --output text 2>/dev/null | sed 's/^/   /' || true
fi

echo
