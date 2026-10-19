# Review instructions

These rules come from real review findings on this repo. Each one names the PR
where it was caught. When a reviewer catches something these rules missed, the
PR author adds a rule here with the example, so it only has to be caught once.

The app books trucks. The costly failures are a truck sold twice, a live hold
released early, or a booking that silently doesn't reach Salesforce. Weigh
findings by how close they come to one of those.

## Severity

- **Important**: double-booking or a lost/early-released hold; data shown to or
  changed by someone who shouldn't have access; a migration that breaks login
  or can't be re-run; a Salesforce or Samsara failure that blocks booking or
  corrupts a record; a total, count or date range shown to a rep that is wrong.
- **Normal**: partial failures that leave the UI and database disagreeing;
  wasted work on every request; a suggestion or button that changes what the
  rep is selling without saying so.
- **Nit**: naming, duplication, coupling, docs that lag the code. At most five
  per review.

## Always check

### Conflicts and holds

- **Conflict identity includes the program.** Anything that decides whether two
  bookings clash, or whether a conflict was already seen or dismissed, keys on
  truck, dates *and* program. Dropping the program lets a new double-booking
  hide inside an old dismissed one. *(#110: `conflictKey` and the prior-decision
  lookup omitted `scheduled_program`.)*
- **Every path where someone chooses a truck runs the conflict check.** New
  entry points (MCP, client portal, internal booking) go through `holdService`
  or its conflict query, not a direct `prisma.hold.create`. *(#51: MCP client
  holds skipped the truck/date check.)* Paths that mirror a booking made
  elsewhere (Salesforce pushes, AT&T sync) are the exception: refusing them
  would drop a record the source system believes is real. They set
  `skipFeasibilityCheck` and their clashes surface through
  `/api/holds/infeasible`. Flag a mirror path that refuses, and flag
  `skipFeasibilityCheck` on any path where a person picks the truck.
- **Expiry can't release a booking someone is still acting on.** Holds with a
  pending extension or approval are exempt from auto-expiry. *(#51:
  `EXTENSION_REQUESTED` holds expired under the cron.)*
- **Date-only values expire at the end of the day,** not at midnight UTC when
  the day begins. *(#51: SFDC `sfdc_hold_exp`.)*
- **Webhooks only touch the rows they own.** The Salesforce hold webhook
  matches on `source: 'SALESFORCE'` as well as the Opportunity id, so it can't
  update or delete client-created holds. *(#51.)*
- **A suppression only suppresses while it's live.** A conflict that was
  auto-resolved and then comes back should notify again; only an active
  conflict or a person's dismissal suppresses email. *(#110.)*

### Who can do it

- **Signed in is not the same as allowed.** A route that changes many holds at
  once, releases AT&T soft holds in bulk, edits settings or reads usage checks
  the role (`session.user.role === 'OPERATIONS'`), not just `!session`. If a
  PR deliberately leaves an action open to every signed-in user, it says so.
  *(#110: any user could approve a 41-truck release; #51: the SALES access
  change was intended and stated.)*
- **The server enforces what the UI assumes.** If the UI only ever sends "all
  or nothing," the API rejects a partial request instead of quietly widening
  it. Responses report what actually happened. *(#110: approving 35 of 41
  trucks released all 41 and reported "41 on 35 trucks.")*

### Salesforce and other outside systems

- **An outage degrades booking; it doesn't block it.** If Salesforce can't be
  reached, the hold is still created and the rep sees the Salesforce error.
  Refuse only on a definite answer (e.g. the contact really isn't on the
  account), never because a read threw. *(#113.)*
- **Risky writes are best-effort or tested in UAT first.** A field that may not
  be writable in every org (e.g. `Opportunity.ContactId`) can't take down the
  whole `createOpportunity` call. The PR lists Salesforce field and permission
  changes in its UAT checklist. *(#113.)*
- **Cheap checks before expensive calls.** Validate the request (ids, dates,
  duplicates) before calling Salesforce or Samsara. *(#113: the contact check ran
  before `requestId` validation.)*
- **Settings that look configurable are actually used.** A new admin field
  (rate card, override, threshold) is read by the quote/availability pipeline,
  not only displayed. *(#51: `service_area_miles` was display-only; the 250-mile
  radius stayed hard-coded.)*

### Grouped bookings and totals

- **A card and its actions cover the same rows.** If a multi-market booking is
  grouped into one card, the total, status badge, expiry badge, Edit dialog and
  bulk actions all use the same set of rows, filtered the same way. Mixed
  statuses (some markets committed, some on hold, some expired) are the normal
  case, not an edge case. *(#115.)*
- **Don't present a partial total as complete.** A sum with a missing (null)
  market says so, and a summed total isn't paired with one market's pricing
  tier. *(#115.)*
- **Displayed ranges are true.** Merging pieces into one date range or one
  block must not cover dates or markets that aren't actually in it. *(#110:
  Oct and Dec soft holds shown as Oct–Dec.)*
- **Approval screens show the evidence.** When a person is asked to approve
  something, the data that justifies it is on the screen, even if it no longer
  counts toward the rule. *(#110: the prior-month column was hidden after the
  10th.)*

### Partial failures

- **Multi-step writes either all succeed or report what didn't.** Don't check
  the first request and ignore the rest, and don't clear a row from the UI until
  every piece is saved. Prefer one request that takes a list. *(#110:
  soft-hold dismiss.)*
- **Don't swallow write failures the user depends on.** If a write that a later
  screen relies on fails, the user sees it, not just the console. *(#110:
  `writeJsonSetting`.)*

### Quotes

- **Suggestions say what they change.** A button that shortens the flight,
  moves dates or changes truck count says so in its label (e.g. "2 days
  shorter"), because it changes price and what's being sold. *(#112.)*
- **Only compute what the response needs.** Expensive searches (alternatives,
  date options) run after we know they're needed, not for every truck on every
  quote. *(#112.)*

### Inputs

- **Validate types, not just ranges.** `Number(true)` is 1; check `typeof`
  before range checks on API input. *(#115: `hold_days: true` booked a 1-day
  hold.)*
- **Search input is escaped.** SOQL/SQL `LIKE` searches escape `%` and `_`, or
  the PR says why not. *(#113.)*
- **Debounced searches ignore stale responses** and clean up on unmount.
  *(#113: `ContactSearch`.)*
- **Times shown to users use the same zone as the server's confirmation**
  (America/Chicago today). *(#115.)*

## Migrations (prisma/migrations)

Schema changes are hand-run SQL against Azure SQL, never `prisma migrate` or
`db push`. Flag any migration that doesn't:

- **Guard every statement** (`IF NOT EXISTS`, `COL_LENGTH(...) IS NULL`) so it's
  safe to run twice.
- **Avoid `GO`.** The portal editor rejects it. Anything that reads a column
  added in the same script goes inside `EXEC(N'...')`.
- **End with a verify `SELECT`** whose expected result is written in a comment.
- **Say "Run BEFORE deploying" in its header** when it adds columns to a model
  Prisma reads. Prisma selects every column, so new columns on `User`,
  `ClientUser` or `McpToken` break login until the script has run.
- **Add, don't drop or rename,** unless the PR description calls out the
  destructive change and how existing data is handled.

The PR description must name the migration file and whether it runs before or
after deploy.

## The PR itself

- **The description matches the diff.** Features deferred to a later PR are
  listed as deferred. Docs touched by the change (`QUOTING.md`, `README.md`)
  are updated in the same PR. *(#113: `QUOTING.md` described a request body
  missing a required field.)*
- **Shared logic lives in shared modules.** General conflict or range logic
  doesn't import from AT&T-specific files; use `lib/ranges.ts`. *(#110.)*

## Do not report

- `node_modules/`, `package-lock.json`, `tsconfig.tsbuildinfo`
- Images and icons in `public/` (`*.png`, `*.ico`). The `public/*.html` files
  are live tools loaded in the app (the classic quote tool's rate card and
  pricing math, the saturation calculator) and are reviewed like any other code.
- Styling-only changes in Tailwind classes, unless they hide information
- Behavior the PR description explicitly calls out as intended, unless it
  breaks a rule above
