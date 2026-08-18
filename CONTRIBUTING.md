# Branching & Review Process

Documented from the live GitHub configuration on `lime-media/lime-scheduling-app`
(ruleset + PR history) — not aspirational, this is what's actually enforced and
actually happened as of 2026-08-10.

## Branches

- **`main`** is the default and only long-lived branch. Everything ships through it.
- Work happens on short-lived topic branches, prefixed by intent:
  - `feature/…` or `feat/…` — new functionality (e.g. `feature/mcp-v2-auth-and-holds`, `feat/admin-mint-endpoint`)
  - `fix/…` — bug fixes (e.g. `fix/admin-middleware-bypass`, `fix/widen-mcp-user-id-column`)
- Branches are **not** auto-deleted on merge (`delete_branch_on_merge: false`) — stale branches accumulate on the remote and get cleaned up manually.
- No CODEOWNERS file and no required-reviewer list — any collaborator can approve any PR.

## Branch protection (ruleset: "Protect Main Branch", active since 2026-07-30)

Applies to `main` (`~DEFAULT_BRANCH`):

| Rule | Setting |
|---|---|
| Deletion | Blocked |
| Force-push / non-fast-forward | Blocked |
| Pull request required | Yes |
| Required approving reviews | **1** |
| Dismiss stale reviews on new push | No |
| Code owner review required | No |
| Required reviewers | None specified |
| Require thread resolution | No |
| Require last-push approval | No |
| Allowed merge methods | merge commit, squash, rebase (all three enabled at repo level) |
| Bypass | **Organization Admins can always bypass** |

There are no GitHub Actions / CI checks wired up (`actions/workflows` is empty) — the
only gate is the one human approval, and org admins can skip even that.

## What actually happens in practice

Looking at PRs #1–#10:

- **PRs opened by a non-admin contributor** (`LMG-Andrew`) got a real review — one
  approval from `Sarah-Lime` before merge, every time (#2, #5, #6, #7). PR #4 from the
  same author merged without a review recorded, but still went through a PR rather than
  a direct push.
- **PRs opened by `Sarah-Lime`** (org admin) were self-approved/merged with no review
  entry (#3, #8, #9, #10) — consistent with the bypass-as-admin rule above, not a
  process violation.
- **PR #1** merged 2026-06-12, before the ruleset existed (created 2026-07-30) — no
  review, self-merged by the author. Predates the protection, not an exception to it.
- Every merge to `main` goes through GitHub's "Merge pull request" flow (merge commit),
  even though squash/rebase are also allowed — the repo has used merge commits
  exclusively so far (`git log --merges` shows `Merge pull request #N from lime-media/<branch>`
  for all 10 PRs).
- Review bodies are consistently empty — approvals are a click, not a written review;
  substantive feedback (if any) happens outside the PR (Slack/in person), not in GitHub review comments.

## Net process

1. Branch off `main` as `feature/…` or `fix/…`.
2. Open a PR back into `main`.
3. If you're not an org admin, you need **1 approval** before merge — no CI gate exists, so review is the only check.
4. If you are an org admin, you can merge without an approval (bypass), and that's the observed pattern for admin-authored PRs.
5. Merge via "Merge pull request" (merge commit) — that's the convention used so far, though squash/rebase are technically permitted.
6. The topic branch is left in place after merge (not auto-deleted).
