#!/usr/bin/env bash
# PreToolUse hook (Bash): the review gate. See CONTRIBUTING.md "Reviews".
#
# 1. `gh pr create` (or its alias `gh pr new`) is blocked until /ship's local
#    review has passed on the exact commit being proposed (a marker written by
#    mark-reviewed.sh), and that commit is what's pushed.
# 2. A second `@claude review` request on the same PR is blocked: the paid
#    Claude Code Review runs once per PR, after the local review.
#
# A guardrail for the normal path, not a security boundary: `gh api`, a PR
# opened from another branch with --head, or a command that cd's into another
# checkout first are not checked.
#
# Exit 2 blocks the command and shows stderr to Claude; exit 0 allows it.
set -uo pipefail

# Every Bash call passes through here, so anything that isn't a PR command
# leaves at once, before jq or git. The pattern stays inside one JSON string
# ([^"]*), so a path or field elsewhere in the hook input can't match it.
input=$(cat)
if ! printf '%s' "$input" | grep -Eqi 'gh[^"]*pr[^"]*(create|new|comment|review)|@claude review'; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Review gate: jq is required to check PR commands. Install jq (brew install jq) and retry." >&2
  exit 2
fi
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# The command with quoted strings emptied: text in a commit message, a grep
# pattern or a comment body never decides what the command is.
bare=$(printf '%s' "$cmd" | sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g; s/'[^']*'/''/g")

# `gh … pr … <verb>` inside one simple command (nothing like ; & | between),
# with gh after a keyword, a brace, env/sudo/xargs, a path, or flags such as
# -R on either side of `pr`.
is_gh_pr() {
  printf '%s' "$bare" | grep -Eq "(^|[^[:alnum:]_.-])gh([[:space:]][^;&|]*)?[[:space:]]pr[[:space:]]([^;&|]*[[:space:]])?($1)([[:space:];&|)\`]|\$)"
}

marker_dir="$(git rev-parse --git-common-dir 2>/dev/null)/claude-local-review"

if is_gh_pr 'create|new'; then
  sha=$(git rev-parse HEAD)
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    echo "Review gate: there are uncommitted changes. Commit them and run /ship so the local review covers what the PR will contain." >&2
    exit 2
  fi
  if [ ! -f "$marker_dir/$sha" ]; then
    echo "Review gate: no passing local review for commit ${sha:0:7}. Run /ship: it runs the checks and the local Claude review, fixes what it finds, and opens the PR. (The paid Claude Code Review runs once, after this.)" >&2
    exit 2
  fi
  # The PR is built from the pushed branch, so the reviewed commit must be
  # exactly what's on origin under this branch's name.
  branch=$(git symbolic-ref --short -q HEAD || true)
  pushed=$([ -n "$branch" ] && git rev-parse --verify -q "refs/remotes/origin/$branch" || true)
  if [ -z "$pushed" ]; then
    echo "Review gate: the branch isn't on origin yet. Push it first: git push -u origin ${branch:-<branch>}" >&2
    exit 2
  fi
  if [ "$pushed" != "$sha" ]; then
    echo "Review gate: origin/$branch (${pushed:0:7}) isn't the reviewed commit (${sha:0:7}). Push it first: git push origin $branch" >&2
    exit 2
  fi
  exit 0
fi

if printf '%s' "$cmd" | grep -qi '@claude review' && is_gh_pr 'comment|review'; then
  # The PR it goes on: a /pull/N URL, else the first bare number after the
  # verb (quoted text is already emptied), else the current branch's PR.
  pr=$(printf '%s' "$bare" | sed -nE 's#.*/pull/([0-9]+).*#\1#p' | head -n1)
  if [ -z "$pr" ]; then
    rest=$(printf '%s' "$bare" | sed -E 's/.*[[:space:]](comment|review)([[:space:]]|$)//')
    pr=$(printf '%s\n' $rest | grep -E '^#?[0-9]+$' | head -n1 | tr -d '#')
  fi
  [ -z "$pr" ] && pr=$(gh pr view --json number --jq .number 2>/dev/null || true)
  [ -z "$pr" ] && exit 0
  # A request someone made: a comment or review body that starts with the
  # trigger. The bot's own messages mention "@claude review" and don't count.
  filter='[(.comments + .reviews)[] | select((.author.login | test("^claude"; "i") | not) and (.body | test("^\\s*@claude review"; "i")))] | length'
  if ! asked=$(gh pr view "$pr" --json comments,reviews --jq "$filter" 2>/dev/null); then
    echo "Review gate: couldn't check PR #$pr for an earlier review request (gh failed). Retry once gh works; a PR gets one paid review." >&2
    exit 2
  fi
  if [ "${asked:-0}" -gt 0 ] 2>/dev/null; then
    echo "Review gate: PR #$pr has already had its one paid Claude Code Review. Verify fixes with a local review (/code-review) instead of requesting another." >&2
    exit 2
  fi
  exit 0
fi

exit 0
