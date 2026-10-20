---
name: ship
description: Open a pull request the team's way — size check, type check/lint/tests/build, a local Claude review with fixes until clean, then the PR and its one paid Claude Code Review. Use whenever work is ready to become a PR in this repo; `gh pr create` is blocked until this has passed on the commit (CONTRIBUTING.md "Reviews").
---

# /ship — local review first, one paid review per PR

The paid Claude Code Review is a multi-agent review billed per run, and its
cost grows with the size of the diff. So every PR is cleaned up locally first
(the reviewer's own Claude Code plan), kept small, and gets exactly one paid
review. A hook (`.claude/hooks/review-gate.sh`) blocks `gh pr create` until
step 4 has recorded a passing local review on the exact commit, and blocks a
second `@claude review` on the same PR.

Work through the steps in order. Stop and tell the person if a step can't pass.

## 1. Ready to ship?
- On a topic branch (not `uat` or `main`), everything committed.
- `git fetch origin`; the base is `origin/uat` unless the person says otherwise.
- Not stacked: the branch is cut from the base, not from another open PR's
  branch. A stacked PR gets reviewed twice whenever its base moves. If it is
  stacked, say so and suggest waiting for the base PR to merge.

## 2. Size
Run `git diff --shortstat origin/uat...HEAD` and `git diff --name-only origin/uat...HEAD`.
- **Over ~600 changed lines or ~15 files** (lockfiles excluded): stop. Propose
  how to split it into PRs of one concern each, and ask whether to split or ship
  as is. If shipping as is, say why in the PR description.

## 3. Checks
Run and fix until clean: `npx tsc --noEmit`, `npx eslint <changed .ts/.tsx files>`,
`npm test`, `npx next build`. Never start a dev server.

## 4. Local review
- Run the `code-review` skill on this branch's changes against `origin/uat`, at
  `medium` effort, with `--fix`. It checks the diff against `REVIEW.md` (loaded
  through `CLAUDE.md`).
- Commit the fixes, re-run step 3, and review again. Repeat until a pass finds
  nothing it would fix (at most 3 passes; if findings remain, show them and ask).
- Record the pass on the final commit:
  `.claude/hooks/mark-reviewed.sh "<N findings fixed: short list, or 'clean'>"`

## 5. Open the PR
Run `git push -u origin <branch>` first, then `gh pr create --base uat` as a
**separate** command (ready for review, not a draft). The gate checks before a
command runs, so `git push && gh pr create` in one call is always refused. The description follows the repo's existing PRs (why, what changed,
verification, how to check it in UAT) and includes this line, filled in:

`Local review: passed at <short sha> — <what it found and fixed, or "clean">`

## 6. The one paid review
Request it once: `gh pr comment <number> --body "@claude review"`.

When it reports:
- Fix each real finding, verify with step 3 and a local `code-review`, push, and
  answer on the PR (finding, cause, resolution, verification, remaining risk).
- **Never request a second paid review.** Fixes after it are verified locally;
  the hook refuses a second `@claude review` on the same PR.
