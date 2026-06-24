#!/usr/bin/env bash
set -euo pipefail

# QKB Release Script
#
# Renames the [Unreleased] section in CHANGELOG.md to the new version,
# bumps package.json, commits, and creates a tag. The actual publish
# happens via GitHub Actions when the tag is pushed.
#
# Usage: ./scripts/release.sh [patch|minor|major|<version>]
# Examples:
#   ./scripts/release.sh patch     # 0.9.0 -> 0.9.1
#   ./scripts/release.sh minor     # 0.9.0 -> 0.10.0
#   ./scripts/release.sh major     # 0.9.0 -> 1.0.0
#   ./scripts/release.sh 1.0.0     # explicit version

BUMP="${1:?Usage: release.sh [patch|minor|major|<version>]}"

# Ensure we're on main and clean
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on $BRANCH)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working directory not clean" >&2
  git status --short
  exit 1
fi

# Use global bun when present; otherwise fall back to npx so Linux CI/agent
# environments without a global Bun install can still run the release script.
if command -v bun >/dev/null 2>&1; then
  BUN_CMD=(bun)
else
  BUN_CMD=(npx --yes bun)
fi

# Verify bun.lock is in sync with package.json
if ! "${BUN_CMD[@]}" install --frozen-lockfile &>/dev/null; then
  echo "Error: bun.lock is out of sync with package.json" >&2
  echo "Run '${BUN_CMD[*]} install' and commit the updated lockfile." >&2
  exit 1
fi
echo "bun.lock: in sync ✓"

# Read current version
CURRENT=$(jq -r .version package.json)
echo "Current version: $CURRENT"

# Calculate new version
bump_version() {
  local current="$1" type="$2"
  IFS='.' read -r major minor patch <<< "$current"
  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
    *)     echo "$type" ;; # explicit version
  esac
}

NEW=$(bump_version "$CURRENT" "$BUMP")
DATE=$(date +%Y-%m-%d)
export NEW DATE
echo "New version:     $NEW"
echo ""

# --- Validate CHANGELOG.md ---

if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md not found" >&2
  exit 1
fi

# The [Unreleased] section must have content
if ! grep -q "^## \[Unreleased\]" CHANGELOG.md; then
  echo "Error: no [Unreleased] section in CHANGELOG.md" >&2
  echo "" >&2
  echo "Add your changes under an [Unreleased] heading first:" >&2
  echo "" >&2
  echo "  ## [Unreleased]" >&2
  echo "" >&2
  echo "  ### Changes" >&2
  echo "  - Your change here" >&2
  exit 1
fi

# --- Preview release notes ---

echo "--- Release notes (will appear on GitHub) ---"
./scripts/extract-changelog.sh "$NEW"
echo "--- End ---"
echo ""

# --- Confirm ---

read -p "Release v$NEW? [y/N] " -n 1 -r
echo ""
[[ $REPLY =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }

# --- Rename [Unreleased] -> [X.Y.Z] - date, add fresh [Unreleased] ---

python3 - <<'PY'
from pathlib import Path
import os
path = Path('CHANGELOG.md')
text = path.read_text()
new = os.environ['NEW']
date = os.environ['DATE']
text = text.replace('## [Unreleased]', f'## [{new}] - {date}', 1)
marker = f'## [{new}] - {date}'
idx = text.index(marker)
text = text[:idx] + '## [Unreleased]\n\n' + text[idx:]
path.write_text(text)
PY

# --- Bump version and refresh lockfile metadata ---

jq --arg v "$NEW" '.version = $v' package.json > package.json.tmp && mv package.json.tmp package.json
npm install --package-lock-only >/dev/null
"${BUN_CMD[@]}" install >/dev/null

git add package.json package-lock.json bun.lock CHANGELOG.md
git commit -m "release: v$NEW"
git tag -a "v$NEW" -m "v$NEW"

echo ""
echo "Created commit and tag v$NEW"
echo ""
echo "Next: push to trigger the publish workflow"
echo ""
echo "  git push origin main --tags"
