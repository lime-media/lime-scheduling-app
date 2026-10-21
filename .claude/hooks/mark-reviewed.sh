#!/usr/bin/env bash
# Records that /ship's local review passed on the current commit, so the review
# gate (review-gate.sh) lets `gh pr create` through for exactly this commit.
# Usage: .claude/hooks/mark-reviewed.sh "<one-line summary of what the review found and fixed>"
set -euo pipefail

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit the review's fixes first; the marker is tied to a commit." >&2
  exit 1
fi
sha=$(git rev-parse HEAD)
dir="$(git rev-parse --git-common-dir)/claude-local-review"
mkdir -p "$dir"
printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${1:-local review passed}" > "$dir/$sha"
echo "Local review recorded for ${sha:0:7}."
