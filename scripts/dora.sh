#!/usr/bin/env bash
set -euo pipefail

# DORA-lite: extract the four DORA metrics from GitHub for danmestas/qkb.
#
# Lead time for changes:    median (PR merged_at - PR created_at) for merged PRs
# Deployment frequency:     count of v* tags per week
# Change failure rate:      % of releases followed by a hotfix tag within 48h
# Mean time to restore:     mean (hotfix tag - prior release tag), when applicable
#
# A "hotfix tag" is a patch-level tag (vX.Y.Z+1 where X.Y stay the same)
# pushed within 48h of the prior release.
#
# Usage:
#   ./scripts/dora.sh             # last 90 days
#   ./scripts/dora.sh --days 30   # custom window
#   ./scripts/dora.sh --json      # machine-readable
#
# Requires: gh (authenticated), jq.

REPO="${REPO:-danmestas/qkb}"
DAYS=90
JSON=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --days) DAYS="$2"; shift 2 ;;
    --json) JSON=true; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# macOS date doesn't support -d; use Python for portability.
SINCE=$(python3 -c "import datetime; print((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=$DAYS)).isoformat().replace('+00:00','Z'))")

# --- Lead time ---
PRS=$(gh pr list --repo "$REPO" --state merged --limit 500 \
  --json number,createdAt,mergedAt \
  --jq "[.[] | select(.mergedAt >= \"$SINCE\")]")

LEAD_COUNT=$(echo "$PRS" | jq 'length')
if [[ "$LEAD_COUNT" -gt 0 ]]; then
  LEAD_MEDIAN_HOURS=$(echo "$PRS" | jq '
    map((.mergedAt | fromdateiso8601) - (.createdAt | fromdateiso8601))
    | sort | (.[length/2|floor] / 3600 * 100 | round / 100)
  ')
else
  LEAD_MEDIAN_HOURS="n/a"
fi

# --- Deployment frequency ---
TAGS=$(gh api "repos/$REPO/tags?per_page=100" --jq '
  [.[] | select(.name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))]
')
TAG_COMMITS=$(echo "$TAGS" | jq -r '.[].commit.sha' | head -100)

# Resolve tag dates by querying each commit (capped to recent 50 to stay polite).
TAG_DATA="[]"
for sha in $(echo "$TAGS" | jq -r '.[].commit.sha' | head -50); do
  date=$(gh api "repos/$REPO/commits/$sha" --jq '.commit.committer.date' 2>/dev/null || echo "")
  name=$(echo "$TAGS" | jq -r ".[] | select(.commit.sha == \"$sha\") | .name")
  if [[ -n "$date" && ! "$date" < "$SINCE" ]]; then
    TAG_DATA=$(echo "$TAG_DATA" | jq --arg n "$name" --arg d "$date" '. + [{name: $n, date: $d}]')
  fi
done

DEPLOY_COUNT=$(echo "$TAG_DATA" | jq 'length')
DEPLOY_PER_WEEK=$(python3 -c "print(round($DEPLOY_COUNT / ($DAYS / 7.0), 2))" 2>/dev/null || echo "n/a")

# --- Change failure rate + MTTR ---
# Sort tags newest→oldest, walk pairs. If a release is patch-bumped within
# 48h of the prior release, count the prior release as failed and record
# the time-to-restore.
SORTED_TAGS=$(echo "$TAG_DATA" | jq 'sort_by(.date) | reverse')
FAILURES=0
RESTORE_TIMES_HOURS="[]"
TOTAL_RELEASES=$(echo "$SORTED_TAGS" | jq 'length')

for ((i=0; i<TOTAL_RELEASES-1; i++)); do
  newer=$(echo "$SORTED_TAGS" | jq -r ".[$i]")
  older=$(echo "$SORTED_TAGS" | jq -r ".[$((i+1))]")
  newer_name=$(echo "$newer" | jq -r '.name')
  older_name=$(echo "$older" | jq -r '.name')
  newer_date=$(echo "$newer" | jq -r '.date')
  older_date=$(echo "$older" | jq -r '.date')

  # Parse vX.Y.Z
  IFS='.' read -r nM nm np <<< "${newer_name#v}"
  IFS='.' read -r oM om op <<< "${older_name#v}"

  if [[ "$nM" == "$oM" && "$nm" == "$om" && "$np" -eq $((op + 1)) ]]; then
    # Patch bump. Was it within 48h?
    delta_hours=$(python3 -c "
from datetime import datetime
n = datetime.fromisoformat('$newer_date'.replace('Z','+00:00'))
o = datetime.fromisoformat('$older_date'.replace('Z','+00:00'))
print((n - o).total_seconds() / 3600)
")
    if (( $(echo "$delta_hours < 48" | bc -l) )); then
      FAILURES=$((FAILURES + 1))
      RESTORE_TIMES_HOURS=$(echo "$RESTORE_TIMES_HOURS" | jq ". + [$delta_hours]")
    fi
  fi
done

if [[ "$TOTAL_RELEASES" -gt 0 ]]; then
  CFR_PCT=$(python3 -c "print(round($FAILURES / $TOTAL_RELEASES * 100, 1))")
else
  CFR_PCT="n/a"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  MTTR_HOURS=$(echo "$RESTORE_TIMES_HOURS" | jq 'add / length | . * 100 | round / 100')
else
  MTTR_HOURS="n/a"
fi

# --- Output ---
if $JSON; then
  jq -n \
    --arg repo "$REPO" \
    --arg since "$SINCE" \
    --argjson days "$DAYS" \
    --arg lead "$LEAD_MEDIAN_HOURS" \
    --argjson lead_n "$LEAD_COUNT" \
    --arg deploy "$DEPLOY_PER_WEEK" \
    --argjson deploy_n "$DEPLOY_COUNT" \
    --arg cfr "$CFR_PCT" \
    --argjson failures "$FAILURES" \
    --argjson releases "$TOTAL_RELEASES" \
    --arg mttr "$MTTR_HOURS" \
    '{
      repo: $repo, window_days: $days, since: $since,
      lead_time_hours_median: $lead, prs_merged: $lead_n,
      deploys_per_week: $deploy, deploys_total: $deploy_n,
      change_failure_rate_pct: $cfr, failures: $failures, releases: $releases,
      mttr_hours: $mttr
    }'
else
  cat <<EOF
DORA-lite for $REPO
Window: last $DAYS days (since $SINCE)

Lead time for changes
  median PR open → merged:        ${LEAD_MEDIAN_HOURS}h  (n=${LEAD_COUNT} merged PRs)

Deployment frequency
  releases per week:              ${DEPLOY_PER_WEEK}     (${DEPLOY_COUNT} total tags in window)

Change failure rate
  releases needing patch <48h:    ${CFR_PCT}%            (${FAILURES} of ${TOTAL_RELEASES})

Mean time to restore
  patch-vs-release delta:         ${MTTR_HOURS}h         (${FAILURES} hotfix events)
EOF
fi
