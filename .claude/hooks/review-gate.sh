#!/usr/bin/env bash
# PreToolUse hook (Bash): the review gate. See CONTRIBUTING.md "Reviews".
#
# 1. `gh pr create` is blocked until /ship's local review has passed on the
#    exact commit being proposed (a marker written by mark-reviewed.sh).
# 2. A second `@claude review` comment on the same PR is blocked: the paid
#    Claude Code Review runs once per PR, after the local review.
#
# Exit 2 blocks the command and shows stderr to Claude; exit 0 allows it.
set -uo pipefail

# Every Bash call passes through here, so anything that isn't a PR command
# leaves at once, before jq or git, and a hiccup can never block other work.
input=$(cat)
case "$input" in
  *"gh pr"*|*"@claude review"*|*"@Claude review"*|*"@claude Review"*|*"@Claude Review"*) ;;
  *) exit 0 ;;
esac

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

marker_dir="$(git rev-parse --git-common-dir 2>/dev/null)/claude-local-review"
ASKED_FILTER='[.comments[] | select((.author.login | test("^claude"; "i") | not) and (.body | test("^\\s*@claude review"; "i")))] | length'

if printf '%s' "$cmd" | grep -Eq '(^|[;&|[:space:]])gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)'; then
  sha=$(git rev-parse HEAD)
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Review gate: there are uncommitted changes. Commit them and run /ship so the local review covers what the PR will contain." >&2
    exit 2
  fi
  if [ ! -f "$marker_dir/$sha" ]; then
    echo "Review gate: no passing local review for commit ${sha:0:7}. Run /ship: it runs the checks and the local Claude review, fixes what it finds, and opens the PR. (The paid Claude Code Review runs once, after this.)" >&2
    exit 2
  fi
  exit 0
fi

if printf '%s' "$cmd" | grep -qi '@claude review'; then
  # The PR this comment goes on: the number after `gh pr comment`, else the
  # current branch's PR.
  pr=$(printf '%s' "$cmd" | sed -nE 's/.*gh[[:space:]]+pr[[:space:]]+comment[[:space:]]+([0-9]+).*/\1/p')
  [ -z "$pr" ] && pr=$(gh pr view --json number --jq .number 2>/dev/null || true)
  if [ -n "$pr" ]; then
    # A request someone made: a comment that starts with the trigger. The bot's
    # own messages mention "@claude review" and don't count.
    asked=$(gh pr view "$pr" --json comments --jq "$ASKED_FILTER" 2>/dev/null || echo 0)
    if [ "${asked:-0}" -gt 0 ]; then
      echo "Review gate: PR #$pr has already had its one paid Claude Code Review. Verify fixes with a local review (/code-review) instead of requesting another." >&2
      exit 2
    fi
  fi
  exit 0
fi

exit 0
