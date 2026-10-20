#!/usr/bin/env bash
# PreToolUse hook (Bash): the review gate. See CONTRIBUTING.md "Reviews".
#
# 1. `gh pr create` (or its alias `gh pr new`) is blocked until /ship's local
#    review has passed on the exact commit being proposed (a marker written by
#    mark-reviewed.sh), and that commit has been pushed.
# 2. A second `@claude review` comment on the same PR is blocked: the paid
#    Claude Code Review runs once per PR, after the local review.
#
# Exit 2 blocks the command and shows stderr to Claude; exit 0 allows it.
set -uo pipefail

# Every Bash call passes through here, so anything that isn't a PR command
# leaves at once, before jq or git, and a hiccup can never block other work.
input=$(cat)
shopt -s nocasematch
case "$input" in
  *gh*pr*|*"@claude review"*) ;;
  *) exit 0 ;;
esac
shopt -u nocasematch

if ! command -v jq >/dev/null 2>&1; then
  echo "Review gate: jq is required to check PR commands. Install jq (brew install jq) and retry." >&2
  exit 2
fi
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# `gh` in command position: at the start of a line or after ; & | ( , with
# optional VAR=value prefixes and -R/--repo flags. Mentions inside a commit
# message or a grep pattern don't count.
GH_CMD='(^|[;&|(])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*gh([[:space:]]+(-R|--repo)([[:space:]]+|=)[^[:space:]]+)*[[:space:]]+pr[[:space:]]+'

marker_dir="$(git rev-parse --git-common-dir 2>/dev/null)/claude-local-review"
ASKED_FILTER='[.comments[] | select((.author.login | test("^claude"; "i") | not) and (.body | test("^\\s*@claude review"; "i")))] | length'

if printf '%s' "$cmd" | grep -Eq "${GH_CMD}(create|new)([[:space:]]|\$)"; then
  sha=$(git rev-parse HEAD)
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Review gate: there are uncommitted changes. Commit them and run /ship so the local review covers what the PR will contain." >&2
    exit 2
  fi
  if [ ! -f "$marker_dir/$sha" ]; then
    echo "Review gate: no passing local review for commit ${sha:0:7}. Run /ship: it runs the checks and the local Claude review, fixes what it finds, and opens the PR. (The paid Claude Code Review runs once, after this.)" >&2
    exit 2
  fi
  # The PR is built from the pushed branch, so the reviewed commit must be what's pushed.
  upstream=$(git rev-parse '@{upstream}' 2>/dev/null || true)
  if [ -n "$upstream" ] && [ "$upstream" != "$sha" ]; then
    echo "Review gate: the pushed branch (${upstream:0:7}) isn't the reviewed commit (${sha:0:7}). Push first: git push" >&2
    exit 2
  fi
  exit 0
fi

if printf '%s' "$cmd" | grep -qi '@claude review' \
   && printf '%s' "$cmd" | grep -Eq "${GH_CMD}(comment|review)([[:space:]]|\$)"; then
  # The PR this comment goes on: a PR URL, else a bare number argument, else
  # the current branch's PR.
  pr=$(printf '%s' "$cmd" | sed -nE 's#.*/pull/([0-9]+).*#\1#p' | head -n1)
  [ -z "$pr" ] && pr=$(printf '%s' "$cmd" | sed -nE 's/.*gh[[:space:]].*pr[[:space:]]+(comment|review)([[:space:]].*)?[[:space:]]([0-9]+)([[:space:]].*)?$/\3/p' | head -n1)
  [ -z "$pr" ] && pr=$(gh pr view --json number --jq .number 2>/dev/null || true)
  if [ -n "$pr" ]; then
    # A request someone made: a comment that starts with the trigger. The bot's
    # own messages mention "@claude review" and don't count.
    asked=$(gh pr view "$pr" --json comments --jq "$ASKED_FILTER" 2>/dev/null || echo 0)
    if [ "${asked:-0}" -gt 0 ] 2>/dev/null; then
      echo "Review gate: PR #$pr has already had its one paid Claude Code Review. Verify fixes with a local review (/code-review) instead of requesting another." >&2
      exit 2
    fi
  fi
  exit 0
fi

exit 0
