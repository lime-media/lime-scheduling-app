# Lime Media Scheduling App

See `README.md` for how the app works, `QUOTING.md` for the quote engine and
`CONTRIBUTING.md` for branching. Topic branches merge into `uat`; `uat` is
promoted to `main`.

Schema changes are hand-run SQL in `prisma/migrations/`, never `prisma migrate`
or `db push`. The migration rules are in `REVIEW.md`.

The review rules below apply when writing code here, not only when reviewing
it. Check new work against them before opening a PR.

Open every PR with `/ship` (local review first, then one paid Claude Code Review;
CONTRIBUTING.md "Reviews"). A hook blocks `gh pr create` until it has passed.

@REVIEW.md
