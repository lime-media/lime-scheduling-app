#!/usr/bin/env bash
# PreToolUse hook (Bash): the review gate. See CONTRIBUTING.md "Reviews".
#
# 1. `gh pr create` (or its alias `gh pr new`) is blocked until /ship's local
#    review has passed on the exact commit being proposed (a marker written by
#    mark-reviewed.sh), and that commit is what's pushed.
# 2. An `@claude review` request is blocked once Claude has reviewed the PR:
#    the paid Claude Code Review runs once per PR, on its own when it opens.
#
# A guardrail for the /ship path, not a security boundary. Shell is matched
# with patterns, so someone determined to skip it can: `gh api`, a PR opened
# from another branch with --head, a command that cd's into another checkout,
# or another repo's PR (-R) are not checked.
#
# Exit 2 blocks the command and shows stderr to Claude; exit 0 allows it.
set -uo pipefail

# Every Bash call passes through here, so anything that isn't a PR command
# leaves at once, before jq or git. The pattern stays inside one JSON string
# ([^"]*), so a path or field elsewhere in the hook input can't match it.
input=$(cat)
if ! printf '%s' "$input" | grep -Eqi 'gh([^"\\]|\\.)*pr([^"\\]|\\.)*(create|new|comment|review)|@claude review'; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "Review gate: jq is required to check PR commands. Install jq (brew install jq) and retry." >&2
  exit 2
fi
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# The command on one line with heredoc bodies dropped and quoted strings
# emptied: text in a commit message, a grep pattern or a comment body never
# decides what the command is, even when it spans lines.
if command -v perl >/dev/null 2>&1; then
  bare=$(printf '%s' "$cmd" | perl -0777 -pe 's/(<<-?\s*([\x27"]?)(\w+)\2)([^\n]*)\n.*?\n\s*\3\s*(?=\n|$)/$1$4/gs; s/\n/ /g; s/"(?:[^"\\]|\\.)*"/""/gs; s/\x27[^\x27]*\x27/\x27\x27/gs')
else
  bare=$(printf '%s' "$cmd" | tr '\n' ' ' | sed -E "s/\"([^\"\\\\]|\\\\.)*\"/\"\"/g; s/'[^']*'/''/g")
fi

# `gh [flags] pr [flags] <verb>`, with gh after a keyword, a brace,
# env/sudo/xargs or a path. Only flags (and their values) may sit around `pr`,
# so `gh pr list --label new` isn't `gh pr new`.
FLAGS='([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:];&|][^[:space:];&|]*)?)*'
is_gh_pr() {
  printf '%s' "$bare" | grep -Eq "(^|[^[:alnum:]_.-])gh${FLAGS}[[:space:]]+pr${FLAGS}[[:space:]]+($1)([[:space:];&|)\`]|\$)"
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
    pr=$(printf '%s' "$rest" | tr -s '[:space:]' '\n' | grep -E '^#?[0-9]+$' | head -n1 | tr -d '#')
  fi
  [ -z "$pr" ] && pr=$(gh pr view --json number --jq .number 2>/dev/null || true)
  [ -z "$pr" ] && exit 0
  # Already reviewed: Claude posted a review or comment (its automatic run),
  # or someone already asked (a body that starts with the trigger).
  filter='[(.comments + .reviews)[] | select((.author.login | test("^claude"; "i")) or (.body | test("^\\s*@claude review"; "i")))] | length'
  if ! asked=$(gh pr view "$pr" --json comments,reviews --jq "$filter" 2>/dev/null); then
    echo "Review gate: couldn't check PR #$pr for an earlier review request (gh failed). Retry once gh works; a PR gets one paid review." >&2
    exit 2
  fi
  if [ "${asked:-0}" -gt 0 ] 2>/dev/null; then
    echo "Review gate: PR #$pr has already had its one paid Claude Code Review (it runs on its own when a PR opens). Verify fixes with a local review (/code-review) instead of requesting another." >&2
    exit 2
  fi
  exit 0
fi

exit 0
