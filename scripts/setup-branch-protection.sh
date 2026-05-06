#!/usr/bin/env bash
set -euo pipefail

# Apply Farley-style branch protection to main.
#
# Idempotent: re-running converges to the declared state. Run once after
# cloning or when policy changes.
#
# Requires: gh (authenticated), repo admin permission.

REPO="${REPO:-danmestas/qkb}"
BRANCH="${BRANCH:-main}"

# Required status checks come from .github/workflows/ci.yml job names.
# Keep this list in sync with the matrix there.
CONTEXTS='[
  "Node 22 (ubuntu-latest)",
  "Node 22 (macos-latest)",
  "Node 23 (ubuntu-latest)",
  "Node 23 (macos-latest)",
  "Bun (ubuntu-latest)",
  "Bun (macos-latest)",
  "CHANGELOG entry required"
]'

PAYLOAD=$(cat <<JSON
{
  "required_status_checks": {
    "strict": true,
    "contexts": $CONTEXTS
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "lock_branch": false,
  "allow_fork_syncing": false
}
JSON
)

echo "Applying branch protection to ${REPO}:${BRANCH}…"
echo "$PAYLOAD" | gh api -X PUT "repos/${REPO}/branches/${BRANCH}/protection" \
  --input - \
  -H "Accept: application/vnd.github+json" >/dev/null

echo "Done. Verify with: gh api repos/${REPO}/branches/${BRANCH}/protection | jq"
