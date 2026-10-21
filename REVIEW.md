# Review instructions

These rules come from real review findings on this repo. Each one names the PR
that changed the code it was caught in: check the PR's file list, because a
review comment is sometimes posted on a neighbouring PR. When a reviewer
catches something these rules missed, the PR author adds a rule here with the
example, so it only has to be caught once.

The app books trucks. The costly failures are a truck sold twice, a live hold
released early, or a booking that silently doesn't reach Salesforce. Weigh
findings by how close they come to one of those.

## Severity

- **Important**: double-booking or a lost/early-released hold; data shown to or
  changed by someone who shouldn't have access; a migration that breaks login
  or can't be re-run; a Salesforce or Samsara failure that blocks booking or
  corrupts a record; a price or total that is quoted, billed or written to
  Salesforce wrong.
- **Normal**: partial failures that leave the UI and database disagreeing;
  wasted work on every request; a suggestion or button that changes what the
  rep is selling without saying so; a figure that is only *displayed* wrong
  (a badge, a summary line, a preview) when what's charged and stored is right.
- When a finding sits between two levels, use the lower one. Important is for
  what has to be fixed before merge; over-rating trains people to skim.
- **Nit**: naming, duplication, coupling, docs that lag the code. At most five
  per review.

## Always check

### Conflicts and holds

- **Conflict identity includes the program.** Anything that decides whether two
  bookings clash, or whether a conflict was already seen or dismissed, keys on
  truck, dates *and* program. Dropping the program lets a new double-booking
  hide inside an old dismissed one. *(#111: `conflictKey` and the prior-decision
  lookup omitted `scheduled_program`.)*
- **Every path where someone chooses a truck runs the conflict check.** New
  entry points (MCP, client portal, internal booking) go through `holdService`
  or its conflict query, not a direct `prisma.hold.create`. *(#51: MCP client
  holds skipped the truck/date check.)*
- **Mirror paths record, they don't refuse.** A path that copies a booking
  made elsewhere (the Salesforce hold webhook, AT&T sync) writes the hold even
  if it clashes, because refusing would drop a record the source system
  believes is real. Its clashes surface through `/api/holds/infeasible`. Such a
  path is marked with a `MIRROR PATH` comment; flag a new one that isn't, and
  flag a mirror path that starts refusing.
- **`skipFeasibilityCheck` needs a reason next to it.** It's fine when the same
  request already checked feasibility (the client hold-request flow after
  `selectTrucksForHold`). Flag it anywhere else a person picks the truck.
- **Expiry can't release a booking someone is still acting on.** A pending
  extension request holds the booking until staff answer, or until the date
  the client asked for (never past the booking's limit), whichever comes
  first: asking sets the booking's `expires_at` to that date. *(#51:
  `EXTENSION_REQUESTED` holds expired under the cron; the booking-unit
  cleanup PR: a request left `expires_at` alone, so it still lapsed at the
  original date while waiting.)*
- **Date-only values expire at the end of the day,** not at midnight UTC when
  the day begins. *(#51: SFDC `sfdc_hold_exp`.)*
- **Webhooks only touch the rows they own.** The Salesforce hold webhook
  matches on `source: 'SALESFORCE'` as well as the Opportunity id, so it can't
  update or delete client-created holds. *(#51.)*
- **A suppression only suppresses while it's live.** A conflict that was
  auto-resolved and then comes back should notify again; only an active
  conflict or a person's dismissal suppresses email. *(#111: `priorDecision`.)*

### Who can do it

- **Staff and clients are the boundary that matters.** Internally there are no
  special roles: every signed-in staff user may hold, edit, cancel or delete
  any booking (Andrew, Oct 2026). Don't flag a staff route for lacking a role
  check. What must hold is that a client session, client portal route or MCP
  call acting as a client only ever sees or changes that client's own
  bookings, and never reaches a staff route. The Operations checks that
  already exist (settings, usage, the AT&T mass-release approval) stay; don't
  remove them without saying so. *(#110: the mass-release approval; this PR:
  role gaps on staff routes were reviewed and left open on purpose.)*
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

### Shared helpers and flags

- **A refactor of a shared helper keeps its default path, and the PR shows
  why.** When a helper many callers use changes shape (new parameters, a new
  return type, a split), every caller that passes nothing new must behave
  exactly as before. The PR description says how that was checked. Getting
  this wrong releases holds early or changes who can book. *(#112:
  `requiresOverride`; #115: `holdExpiry`. Both were correct; proving it took
  most of the review.)*
- **A flag that widens what's allowed defaults to off and is checked at every
  call site.** List each caller that passes it and confirm the ones that
  shouldn't (the client portal, MCP) don't. *(#112: `softHoldStrandIsWarning`
  was safe because the client path didn't pass it.)*

### Grouped bookings and totals

- **A booking is the unit.** A booking (`bookingKey`: every market of a
  multi-market quote, a campaign group, or an opportunity) has one card, one
  status, one total, one expiry, and its actions act on all of it, on
  Reservations and in the client portal alike. Mixed statuses only exist in
  bookings made before #118; those still get one card that names the markets
  out of step. *(#115 split a booking into a card per status; Andrew,
  2026-10-20: "It is one quote.")*
- **A card and its actions cover the same rows.** The card's total, status
  badge, expiry badge, Edit dialog and actions all use the same set of rows,
  filtered the same way. *(#115.)*
- **Client portal actions act on the whole booking.** A client never acts on
  one market or one truck of a booking: an extension request (and anything
  added later) covers every hold of it, in one request, with one email.
  *(Booking-unit cleanup: the portal grouped by `campaign_group_id`, so a
  multi-market booking's extension request marked one market and staff
  approved one market's date.)*
- **Closed Won is read-only in the app, except truck swaps.** A committed hold
  is a won deal (`closedWonRefusal`): no cancel, delete, expiry edit, revise or
  quote added to the opportunity; the server refuses with "change it in
  Salesforce first". A truck swap (logistics; the deal is unchanged) is the
  one change allowed. Any new path that changes or deletes holds checks it.
  *(Booking-unit cleanup: `update_expiration` turned COMMITTED holds back
  into HOLD, cancel and delete paths ignored Won, and attach accepted a Closed
  Won opportunity id.)*
- **The app owns LED Hold Exp.** Every path that releases a truck or re-dates
  a hold syncs LED Hold Exp and LED Trucks to Salesforce from the app's live
  holds (`syncOpportunityLedWindow`): reinstate, approve or deny extension,
  Edit expiry, cancel, hold PUT/DELETE, chat and conflict release, a client's
  extension request, and the expiry sweep. The hold webhook treats the echo of
  that write as no change (`pushedHoldExpiry`); the date the app wrote is
  recorded in the Salesforce-made holds' `features` (`appHoldExp`), never in
  `sfdc_hold_exp`, which keeps deciding whether a lapse closes the deal.
  Listing only held trucks is what stops Salesforce's push from mirroring or
  reviving a truck the app isn't holding, so a write that lists trucks the app
  didn't take back is a double-booking. Reinstate is all or nothing for the
  same reason. Flag a new release or re-date path that
  doesn't sync. *(Reinstate write-back review: a partial reinstate's push
  revived a refused truck; delete, chat, conflict and sweep releases didn't sync.)*
- **While the app holds trucks on an opportunity, it's the app's.** For
  app-made bookings, trucks and Hold Exp change only in the app: the hold
  webhook never creates, changes or deletes holds from a push's LED fields on
  such an opportunity (any app hold not yet EXPIRED: one past its expiry
  counts until the sweep releases it and re-syncs). Once the app's booking is
  released, Salesforce is in charge again and a push is mirrored (recorded,
  never dropped); Reinstate removes such copies of its own trucks. Anything that writes Salesforce
  for a Closed Lost reopen does it after the holds are saved, undoing them if
  Salesforce refuses, so the push it fires finds them live.
  When the push differs from what the app would write (`ledFieldsDiffer`), the
  app writes its own values back and records `SFDC_LED_FIELDS_OVERRIDDEN`; the
  follow-up push matches, so it can't loop (compare Hold Exp only when the app
  writes one). Only opportunities made purely in Salesforce are mirrored.
  Flag a webhook change that lets a push edit an app-booked opportunity's
  holds, or a re-sync that can disagree with itself. *(#123 review: trucks
  re-entered in Salesforce on app bookings were silently dropped, then
  patched with per-truck echo rules that missed app-only opportunities.)*
- **Only Salesforce commits a hold, and a lock always has a way back.**
  Committed means Closed Won, in both directions: nothing in the app marks a
  hold committed unless Salesforce says the deal is Closed Won, and the
  reconcile moves a committed hold back (HOLD if reopened, EXPIRED if lost)
  when the deal leaves Closed Won (`reconcileTarget`). A committed hold with no
  opportunity is never locked. Flag any new way to commit, and any lock whose
  "change it in Salesforce" message has nothing in Salesforce to change.
  *(#120: "Mark committed (won)" on the schedule locked holds for good.)*
- **A multi-market booking is one quote: one expiry for the whole booking,
  capped by the earliest market's start, on every hold.** Booking, Edit,
  reinstate and approve-extension all set the same date on every hold, and a
  date past the limit is refused, not quietly cut back. *(#115 capped each
  market by its own start.)*
- **Don't present a partial total as complete.** A sum with a missing (null)
  market says so, and a summed total isn't paired with one market's pricing
  tier. *(#115.)*
- **Displayed ranges are true.** Merging pieces into one date range or one
  block must not cover dates or markets that aren't actually in it. *(#111:
  `mergeSoftHoldClashes` showed Oct and Dec soft holds as Oct–Dec.)*
- **Approval screens show the evidence.** When a person is asked to approve
  something, the data that justifies it is on the screen, even if it no longer
  counts toward the rule. *(#110: the prior-month column was hidden after the
  10th.)*

### Partial failures

- **Multi-step writes either all succeed or report what didn't.** Don't check
  the first request and ignore the rest, and don't clear a row from the UI until
  every piece is saved. Prefer one request that takes a list. *(#111:
  soft-hold dismiss in `AttSoftConflicts.tsx`.)*
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
  doesn't import from AT&T-specific files; use `lib/ranges.ts`. *(#111.)*

## Do not report

- `node_modules/`, `package-lock.json`, `tsconfig.tsbuildinfo`
- Images and icons in `public/` (`*.png`, `*.ico`). The `public/*.html` files
  are live tools loaded in the app (the classic quote tool's rate card and
  pricing math, the saturation calculator) and are reviewed like any other code.
- Styling-only changes in Tailwind classes, unless they hide information
- Behavior the PR description explicitly calls out as intended, unless it
  breaks a rule above
