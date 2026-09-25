# How LED Quoting Works Today

**Audience:** Lime Media operations team
**Scope:** Every variable that moves a number on an LED truck quote, as the code behaves today
**Last updated:** 2026-09-11 — transport unified onto a single engine
**Source of truth:** `lib/pricing/` in `lime-scheduling-app` (branch `uat`, as of 2026-09-11)

This describes what the system *actually does right now*, not what the spec says it should do. Where those two disagree, the disagreement is called out.

---

## 1. The short version

A quote is built in four passes:

1. **Count the days** the trucks actually work (activation days).
2. **Pick a daily rate** from the rate card, based on duration.
3. **Add media features** — shadow fencing, smart directional, device ID, lift studies.
4. **Decide whether transport is free or billed**, and add it if billed.

Everything below is the detail inside those four steps.

---

## 2. Counting days

This is the variable that surprises people most often, because **calendar days and billed days are not the same number.**

### Activation days vs. calendar days

The system bills **activation days** — days a truck is actually out working — not the length of the date range.

The schedule defaults by campaign length:

| Campaign length (calendar) | Default schedule | Effect |
|---|---|---|
| 6 days or fewer | 7 days/week | Every day is an activation day |
| 7 days or more | 5 days/week (Mon–Fri) | Weekends are skipped and not billed |

The client can override this to 5, 6 (Mon–Sat), or 7 days per week.

**Worked example.** A campaign running Mon Sept 1 → Sun Sept 14 is **14 calendar days**. At the default 5-day schedule for a 7+ day campaign, that's **10 activation days** — the four weekend days drop out. You quote 10 days, not 14. This also pulls the campaign to exactly the 10-day threshold that matters for transport (§6).

### Lead time

Lead time is counted in **business days between today and the campaign start date**, excluding both endpoints. Weekends don't count; holidays are *not* accounted for.

The threshold everywhere in the system is **10 business days**. Under 10 is a "rush."

---

## 3. The rate card

Per truck, per day, for a standard 8-hour operating day:

| Duration | Rate per truck-day |
|---|---|
| 1 day | $1,850 |
| 2–10 days | $1,350 |
| 11–19 days | $1,200 |
| 20+ days | $1,200 |

The 11–19 and 20+ tiers are the same number, so in practice there are **three** price points, not four.

### Cumulative truck-day optimization

The rate is not chosen on duration alone. The engine looks up a rate two ways and **takes the cheaper one**:

- the rate for the **per-truck duration** (how many days each truck works), and
- the rate for **total truck-days** (trucks × days).

**Worked example.** Three trucks for one day is 1 day per truck (→ $1,850) but 3 total truck-days (→ $1,350). The client gets **$1,350**. This is why a multi-truck one-day activation doesn't get hit with the single-day rate.

### Operating hours

- Standard day is **8 hours**.
- Each hour above 8 adds **$150 per truck-day**.
- Hours are capped between 8 and 12 — outside that range the quote is rejected outright.

The surcharge is added to the daily rate *before* everything else, so it flows into base media and therefore into the shadow fencing calculation too.

**Base media = truck-days × (daily rate + hourly surcharge)**

---

## 4. Media features

| Feature | How it's priced |
|---|---|
| **Shadow fencing** | 25% of base media, with a **$5,000 floor** |
| **Smart directional** | $250 per truck-day |
| **Device ID passback** | $2,500 flat, regardless of size |
| **Lift study** | $7,500 each |

**The shadow fencing floor bites on small campaigns.** 25% only exceeds $5,000 once base media passes $20,000. Below that, every client pays exactly $5,000 and the quote flags it as "floored."

Digital impressions are derived from the fencing spend at a **$10 CPM** — i.e. `shadow fencing ÷ 10 × 1,000`.

### Lift study eligibility

Studies are **gated on estimated physical impressions** and are silently dropped if the campaign is too small.

`Estimated impressions = trucks × days × daily A18+ for the market tier`

| Tier | Market type | Daily A18+ impressions per truck |
|---|---|---|
| 1 | Top-2 mega-DMA (NY, LA) | 90,000 |
| 2 | Top-10 major metro | 60,000 |
| 3 | Standard mid/large DMA | 40,000 |
| 4 | Sub-DMA / small metro | 20,000 |

The campaign must clear **1,200,000 estimated impressions** to qualify. If it doesn't, the studies are removed and **billed at $0** — the client isn't charged, but they also don't get the study. Worth checking on any small campaign where a study was promised in the room.

**Worked example.** 1 truck, 10 days, mid/large market = 1 × 10 × 40,000 = 400,000 impressions. **Below the threshold** — no study, even if requested. That same campaign needs 3 trucks (1.2M exactly) to qualify.

### How market tier gets picked

The market name on the quote is fuzzy-matched against the active accepted-markets list, then mapped by DMA code:

- New York and LA → Tier 1
- Chicago, Dallas, Philadelphia, Houston, Atlanta, DC, San Francisco, Boston → Tier 2
- **Everything else → Tier 3**

If the market can't be matched at all, it falls back to **Tier 3**. Note that Tier 4 is never assigned automatically — see §8.

---

## 5. Rate agreements (per-client pricing)

A client with an active **Rate Agreement** gets overridden pricing. Agreements are matched on Salesforce Account ID (preferred) or legacy partner ID, and must be inside their effective/expiration window. The most recently created match wins.

Any of these can be overridden per client:

- Daily rates, per tier
- Shadow fencing percentage and floor
- Smart directional daily rate
- Device ID flat fee
- Study cost
- Hourly surcharge
- **`transport_included`** — always absorb transport for this client
- Service-area radius, transport day rate, airfare, hotel per night

There is also an editable **default rate card** stored as an agreement under the special account ID `__default__`. If present, it applies to everyone; if absent, the hardcoded values in this document apply.

**Important operational behavior:** if the rate agreement lookup *fails* (database error, malformed JSON), the system does **not** error out. It silently falls back to the standard rate card and the client gets list pricing. A quote that came back at standard rates for a contracted client is worth re-running before it goes out.

---

## 6. Transport logic

Transport is a **layer on top of** media pricing, not a separate product. When it's absorbed, the client sees **no transport line at all** — not a $0 line.

**There is one transport engine.** Every surface — the Quote Builder, the rep quote page, hold requests, and the AI/MCP endpoint — calls the same function in `lib/pricing/transport.ts`. The rules below apply identically no matter where the quote came from.

### Who gets billed

Transport is evaluated **per truck**. Each truck is bucketed by its distance from the campaign:

| Distance from campaign | Bucket | Transport charge |
|---|---|---|
| 0–50 miles | Local | None |
| 51–250 miles | Nearby | None |
| Over 250 miles | **Repositioning** | Billed, unless absorbed |

Only repositioning trucks generate a charge. A mixed fleet — two local trucks and one from 400 miles out — is billed for the one truck. **A truck already in market is never charged for repositioning it doesn't do.**

### When it's free

**Transport is absorbed when either:**

- the client's rate agreement has `transport_included`, **or**
- the campaign is **10+ activation days** AND lead time is **10+ business days**.

**Both conditions must hold.** A 30-day campaign booked with 5 business days' notice is billed for transport. So is a 4-day campaign booked three months out.

### How much

Per repositioning truck, from that truck's own distance:

```
transport days   = distance ÷ 450, rounded up (minimum 1)
overnights       = transport days − 1
charge per truck = (transport days × $750) + $350 airfare + (overnights × $210 hotel)
```

| Distance | Transport days | Charge per truck |
|---|---|---|
| 300 mi | 1 | $1,100 |
| 500 mi | 2 | $2,060 |
| 1,000 mi | 3 | $3,020 |

The 450-mile figure is **how far a truck drives in a day** — it is not the 250-mile service boundary. Two different numbers doing two different jobs.

A **deposit** of one transport day (**$750 per repositioning truck**) is required whenever transport is billed.

### Truck count is not part of the model

Asking for more trucks than a market normally holds is **not** a reason to refuse or to re-price. The extra trucks come from wherever they are, and the distance they travel is billed as transport like any other repositioning. A four-truck campaign in a one-truck market is quotable; it is simply more expensive.

There is no swarm rule, no concurrency cap, and no per-market truck limit anywhere in pricing.

> **History.** A "swarm" trigger was intended to mean *more than three trucks concurrently in one market*. That was never implemented. On 2026-09-11 a gate keyed on each market's `base_concurrency` shipped instead — and since all 50 markets are seeded at `base_concurrency = 1`, it refused **every multi-truck request in every market**. Both the gate and the concurrency concept were removed on 2026-09-12. If a swarm rule is wanted, it needs deciding from scratch: what the threshold means, and whether it should gate a quote at all or simply flag one.

### The only two reasons a quote is refused

1. **Outside the service area** — the campaign market cannot be located. Lime Media serves the contiguous 48 states.
2. **No reachable truck** — every truck is either booked, cannot arrive in time, or would strand a later commitment.

Anything else gets a price, however large. A campaign needing trucks from 1,000 miles away is expensive, not impossible, and the buyer is entitled to see the number.

### One engine, two ways of measuring distance

The rules never change, but *where the distance comes from* depends on whether trucks have been picked yet:

| Surface | Distance measured from |
|---|---|
| Quote Builder, rep quote, hold requests | Each truck's **live GPS position** |
| AI / MCP endpoint | The **nearest accepted market**, for every truck |

The MCP endpoint runs before truck selection, so it can't know where individual trucks are. It assumes every truck starts at the nearest accepted market, which is deliberately **conservative** — an MCP quote can come in *higher* than the final quote, never lower, because real trucks are often closer than the market centroid.

**This is an estimate, not a disagreement.** Same rules, same formula, same thresholds. If an MCP quote and a rep quote differ, it is because the real trucks were closer than assumed — not because two different rule sets were applied. MCP responses mark billed transport with `estimated: true` and report the distance used.

### Cancellation

If a truck was already dispatched, the cancellation charge equals the full transport charge for that distance. If it wasn't dispatched, the charge is $0.

## 6b. Feasibility: can the truck actually do it?

Pricing answers *what it costs*. Feasibility answers *whether it is possible*, and it is checked separately. A truck is only offered if all three hold:

```
   [ prior job ] --travel--> [ THIS CAMPAIGN ] --travel--> [ next job ]
        Mp                          M                          Mn
              rule 1              rule 2              rule 3
```

**Rule 1 — it can arrive.** Transport days from where the truck is *released* must fit in the time before the campaign starts. A truck in LA needs 3 days to reach Oklahoma City; if the campaign starts in 2 days, it is not an option, idle or not.

**Rule 2 — it is free.** Nothing else is booked during the campaign itself — holds *and* scheduled LED programs.

`checkChainFeasibility()` deliberately does **not** test this: a job straddling the campaign is neither a predecessor nor a successor, so the chain check has nothing to say about it. The window is the caller's job, and the shared `findWindowClash()` is what every caller runs — the quote path, the single-truck check behind the hold writes, the infeasible-hold audit, and the MCP availability endpoint. A caller that skips it loads the truck's schedule blocks and then books straight over them, which is exactly what happened on the chat route.

> **Known limitation.** Schedule data is windowed to roughly today −30 to +63 days, so a program booked further out than about two months is not visible to this check. Pre-existing across the codebase, not specific to feasibility.

**Rule 3 — it does not strand its next job.** After the campaign, the truck must still reach whatever it is already committed to. If the next job is in Seattle starting the day after ours ends, and Seattle is 5 transport days away, taking this booking would break a job you have already sold.

Both travel rules count the **days actually free between jobs**. A campaign ending the 25th with the next job starting the 26th has **zero** free days, not one — the 25th belongs to the campaign and the 26th to the next job. Back-to-back bookings therefore need the next market to be inside the service area, or they are refused.

### What the reservation truck-picker shows

The swap picker on the Reservations page reports, per truck:

- **Departs `<market>`** — where the truck will be when *this campaign* starts, not where it is today
- **from its prior booking** or **current GPS position** — which of the two sources that came from
- **`TRANSPORT 2d · $2,060`** or **`IN MARKET`** — whether this choice incurs a repositioning charge, and how much
- **`NEEDS SOFT-HOLD RELEASE`** — available only by displacing an `ATT_SOFT` hold

When the origin is a prior booking, the truck's *present* GPS market is shown underneath in parentheses, since those differ precisely when the distinction matters.

The reservation's own hold is excluded from the timelines while this runs, so the truck currently assigned does not block itself and is measured on the same basis as the alternatives offered beside it.

### Where the truck departs from

Distance is measured from where the truck **will actually be** when the campaign starts. Two sources, and which applies depends on whether the truck is committed between now and then:

| Truck's situation | Origin used |
|---|---|
| Running a program **now** | that program's market |
| Program or hold **scheduled** before the campaign starts | that market |
| **Two or more** committed before the campaign | the **latest** one's market |
| Only an `ATT_SOFT` placeholder | **live GPS** |
| No current or upcoming commitment | **live GPS** |

A truck working Miami through the 12th is a Miami truck for a campaign starting the 14th, wherever its GPS reads today — it is committed there.

`ATT_SOFT` holds never set the origin. They are placeholders that may be voided, and they are written with an empty market, so treating one as an origin would gate the truck's departure behind a hold it may never serve.

But a campaign that **already finished** is not evidence of position. Trucks are repositioned between jobs constantly, so a market a truck left three weeks ago says nothing about where it sits now. For an idle truck, GPS is the only thing that knows. Only jobs ending **on or after today** and before the campaign qualify as the origin.

The same distance drives both the feasibility check and the transport charge, so they can never disagree. If neither source resolves, the truck is reported as `UNKNOWN_ORIGIN` rather than quietly dropped.

### Overrides

A **hard commitment** (`HOLD`, `COMMITTED`, or scheduled program work) can never be stranded — the truck is excluded, full stop.

A **soft hold** (`ATT_SOFT`) may be displaced. Those trucks are returned flagged as `requiresOverride`: they are never auto-selected by a quote or hold flow, but a rep can see them and make the call.

### What a refusal says

A refused quote leads with the operative fact:

> **Automatic quote not feasible without changing existing reservations or commitments.**

On staff surfaces a second line adds the internal breakdown — how many trucks can reach the market, how many were excluded for not arriving in time, how many would strand a later booking. **Client surfaces get the headline only**; truck counts and exclusion reasons are fleet posture.

### Nothing disappears silently

Trucks ruled out come back in an `excluded` list with the reason and a plain-English detail, and are counted as `cannotArrive` / `wouldStrandSuccessor`. Thin availability should read as a logistics constraint, not an empty fleet.

### Deadhead on the next job — flagged, never billed

Taking a truck can leave it further from its next commitment than it would have been. The system computes that difference (`deltaTransportDays`, `deltaCost`) and reports it under `_internal.chainFlags`.

**It is not added to the price.** The next job's transport was quoted when that job was booked and is not re-rated here. The delta can be negative when a campaign happens to move a truck toward its next job. Over time these are expected to offset.

### Not modelled: repositioning home

A campaign that leaves a truck far out with nothing after it carries **no return leg**. This has never been priced and is not introduced here.

### Where the rules are enforced

| Path | Behavior |
|---|---|
| Quote Builder, rep quote, hold requests | gated at truck selection |
| Grid hold, MCP hold (`createHold`) | **hard blocked** — `feasibility_conflict` |
| AI chat hold | **hard blocked** |
| MCP availability (`?market=`) | reports `feasibility` per truck |
| Salesforce push | writes, never blocked |
| ATT sync | writes, never blocked |

The last two **mirror** bookings that already exist upstream. Refusing them would drop a record the source system believes is real, so they write unconditionally and are surfaced instead by:

```
GET /api/holds/infeasible
```

That endpoint recomputes feasibility across every active hold and returns the ones that cannot be served, with the reason. It is deliberately **not** a stored flag on the hold row — feasibility is a property of the whole chain, so a flag written at insert time is wrong the moment a neighbouring job moves. A hold booked cleanly in March can become infeasible in April because something else changed around it; only recomputing catches that.

If the feasibility lookup itself errors, the hold is allowed through and the error is logged. A logistics service being down should not stop the business taking a booking.

### Asking the MCP availability endpoint the right question

`GET /api/v1/internal/availability` answers "when is each truck booked?" — a calendar view that says nothing about whether a truck could serve a given market. Pass an optional **`market`** parameter and every truck is additionally run through the chain rules, returning a `feasibility` block per truck plus a top-level `feasibility_checked` flag.

**A free calendar slot is not the same as a servable truck.** Callers that omit `market` get the old behavior, unchanged — and no feasibility guarantee.

### Where market coordinates come from

Every scheduled shift requires selecting a market, and that selection carries a `standard_market_uid`. Where the LED schema includes bounding boxes on `standard_market_lookup`, the market's centroid travels with the job — **the coordinates are the market the team chose**, not a guess from its name.

The old path was a 281-entry hardcoded file (`lib/marketCoordinates.ts`), built in June 2026 for grid proximity filtering and never intended as an authoritative list. Measured against production's 355 standard markets it covers **61%**; 137 markets had no coordinates at all, and 63 file entries are not markets. It remains only as a first-pass shortcut and a fallback where the bounds migration has not landed.

Records that carry no `standard_market_uid` — holds, and campaign markets typed by a rep — are matched **by name against the same 356-market list**, not the file. New holds are also **written with the canonical market name**, so a hold recorded as "dallas" is stored as "Dallas, TX" and can resolve its own coordinates later. An unrecognized market is stored as typed rather than rejected — it never blocks a booking.

Market input on a quote resolves against **both** sources. `/api/markets` autocompletes from the 356-market list, so gating on the hardcoded file alone would have rejected markets a rep had just selected from the dropdown. So every market the team can schedule now resolves, whichever path it arrives by.

The bounds columns reach environments at different times, and referencing a column SQL Server does not have is a hard error rather than a null — so capability is detected once per process (`hasMarketBounds()`) and the query is chosen accordingly. A market row with null bounds behaves exactly as if the columns were absent.

### When a market name does not resolve

Where no source resolves a market, distance depends on matching names against the coordinate map. When a prior job's market cannot be matched, the truck **falls back to live GPS** — the old, wrong basis — rather than failing.

The fallback is only reported when the unmappable job **has not started yet**. If the job is already running, the truck is physically in that market, so its GPS reads the right place and the distance is correct — there is nothing to verify. Only an upcoming job makes GPS describe where the truck *is* rather than where it will *depart from*.

When it does fire, it is counted and reported, never silent:

- staff quote shows a red "priced from GPS, not their prior job" warning naming the markets
- `/conflicts` shows a "Market names not recognized" banner
- the server logs a warning per quote

A non-zero count means market names are drifting from the coordinate map and some transport is being priced from the wrong origin. Fixing it is a data task: add the missing markets to the map.

### Why transit days are not blocked on the calendar

Feasibility is recomputed from the stored job chain every time, so a second campaign evaluating the same truck sees the first campaign as a job and has to route around it. Writing transit days into the calendar would be **derived data** — correct only for the chain that existed when it was written, and stale the moment a job moves or cancels. Blocking transit on the grid is a display question, not a correctness one.

## 6c. Multi-market quotes (LED Quote → Multi-market Quote)

The single-market quote, for many markets at once. The rep picks the client, lists the markets (typed, or imported from the client's ZIP file), and gets one quote. Behind it, a routing engine decides which real trucks serve which markets. Then one button places every hold and one Salesforce opportunity. Internal only; nothing here is exposed on a client route.

**Input.** One row per market: market, start, end, trucks, schedule, hours (8, 10 or 12). The schedule is priced exactly as the single-market quote prices it (§2). For a range of 6 days or fewer that page hides its schedule buttons and sends its default, Mon–Fri, so a short range bills its weekdays; a longer range picks Mon–Fri, Mon–Sat or 7 days. (`SHORT_RANGE_DAYS_PER_WEEK` in `lib/planning/quote.ts`; change it with the single quote.) It can also pick **3 days a week**, which bills three days in each full week (and up to three in a part week) and is the only schedule that lets a truck alternate between two markets. Every row can be edited. Typed markets resolve the same way as the single-market quote; an ambiguous name shows its candidates to click. An imported client file fills the rows (see *List intake* below), using the bulk dates and schedule the rep sets. AK and HI are refused: Lime Media serves the contiguous 48 states.

**The routing engine** (`lib/planning/order.ts`) finds the way to meet every row with the fewest trucks, then the least transport, then the least driving. That also leaves the most trucks for other clients. It never moves a date or changes a schedule the rep asked for; those only appear as alternatives.

1. **Share.** Two truck-slots share one truck when it can alternate between them within a week. That means both markets are within the hop limit (default 250 road miles: straight line × 1.25), their dates overlap, and both are on 3 days a week (3 + 3 + 1 travel day fits in a week). A maximum matching gets the most shares first, then the shortest hops. The search is bounded by a fixed amount of work, not by the clock, so the same order always routes the same way at quote time and at booking. The hop limit is held between 50 and 450 miles whatever a request asks. A shared truck has two drivers.
2. **Chain.** Jobs that follow each other in time go on one truck if it can get from the end of one to the start of the next in time (transport days as in §6). A minimum path cover gives the fewest trucks first, then the least transport.
3. **Assign.** Each chain gets a real truck by number (e.g. 1261). The truck must be free for the whole chain and able to arrive in time from where it is released (its prior job, else live GPS). It also must not strand its next hard booking, reached from where the chain actually ends (for a shared truck, whichever market the rotation finishes in). This is the same chain check as every quote (§6b). A minimum-cost assignment on the transport we absorb picks which truck. A chain no truck can take is split in half and tried again, down to single jobs, so as much as possible stays on one truck.

The pool is the bookable fleet (`HIDDEN_TRUCKS` excluded), with jobs and holds loaded through the order's last date plus six weeks, so that later-start alternatives can see the fleet. Reservations:

- **AT&T soft holds are permanent.** Trucks on the latest month of `ATT_SOFT` holds are held back, however old that month is. If none are on file, the quote warns.
- **Alloy Build renewing** (optional toggle). Trucks currently on AT&T's Alloy Build (booked under 160over90, matched by "contains") are held back too.

**Pricing** is per market, at the single-market rates. Each market is billed for the truck-days the plan's trucks actually work there, read from the same day-by-day rotation the holds are cut from, plus the requested days for any truck the fleet cannot cover. A truck of its own works the schedule over the date range. A shared truck gives each market its 3 days in every full week, but the final part-week can only go to one of them, so the other gets (and pays for) fewer days. Nothing is overstated: each market shows the dates its trucks actually work (first and last working day, with the requested range beneath when they differ, in amber when days are short) and the arithmetic of what is billed: full weeks, plus the final part-week with its real dates and the days it actually gets. The same real dates and counts go to the Salesforce Description, and the opportunity's hold start and stop are the first and last working days. Because the rate depends only on total truck-days, this prices exactly as trucks × days would. Media is `computeQuote()` on those truck-days, hours and tier, with the chosen features. It uses the client's rate agreement if one exists, else the rate card. A shared truck is billed in both markets it serves. Transport follows the existing rules per move: the legs that arrive at a market are priced against that market's activation days and lead time. That makes them free inside the service area, absorbed when the market clears both tests, and billed otherwise (§6). Under each market, every truck shows where it comes from, as in the single-market quote. That is its last job before this order, its live location, or an earlier market in this order. An out-of-market truck shows the miles, travel days, and the charge or "included" (with what we absorb); an in-market truck shows its miles; a shared truck shows its weekly hop. The quote shows each market's media, transport and total; the order total; how many trucks come from out of market and how far; the transport we absorb; deadhead miles; trucks used out of those available; and trucks left for other clients. Lift studies are not offered on multi-market quotes.

**Alternatives** are re-runs of the same engine and pricing:

- **Markets we can't do.** Each market with trucks short, and the earliest another truck could get there (travel included). When more than three markets are short, they are grouped into one line.
- **Fewer trucks.** A hop limit 100 or 200 miles wider (up to 450), shown only if it saves trucks without losing coverage.
- **Hours model.** 5 × 8 markets as 3 × 12, or the reverse: the change in trucks and order total.
- **Start date.** If markets are short, the first start 1–6 weeks later that covers every market. Otherwise, a start 1–3 weeks later that cuts transport by $500 or more.

**Holds and Salesforce** (`/api/plan/hold`). The client must be selected, and the rep ticks the markets to book (every market with a truck starts ticked). Changing any market, option or the client clears the quote, so the button always books what is on screen. The selected markets are re-routed from fresh data at the moment of booking. Then:

- **Price check.** The browser sends the total it showed. If the fresh plan prices differently, nothing is booked and the rep is asked to confirm the new total.
- **Shortfalls.** If some trucks can no longer be covered, the rep is asked before the rest are booked.
- **All or nothing.** Every stretch is checked against existing holds first; if any truck was booked since the quote, nothing is written and the rep gets a fresh quote. The holds are then written in one transaction, so a failure leaves none behind.
- **Retries are safe.** Each quote carries a booking id, and the holds are grouped under ids made from it. Retrying after a timeout finds the first attempt's holds and returns them; it never books a second set or a second opportunity.
- **Holds are by market.** A truck on one market gets one hold per job. A truck alternating between two markets gets a hold for each stretch it spends in each one, following its rotation (A Mon–Wed, travel Thu, B Fri–Sun, B Mon–Wed, travel Thu, A Fri–Sun, …). The holds sit back to back and never overlap, and the travel day stays on the stretch it leaves. Each market is its own campaign group, so the hold pages show it as its own campaign with its own total.
- **What a client sees.** A linked client can see its holds' notes, breakdown and total in the portal. Each hold carries only its own market's figures, in the same breakdown shape as a single-market hold: never truck origins, the transport we absorb, fleet counts or other markets.
- **Market names on holds.** A market imported from a ZIP list is booked under its nearest standard market (name and state), so the hold resolves to a place for later availability checks.
- **One Salesforce opportunity** for what is booked. The amount is the booked markets' total. The Description lists each booked market, then the markets **quoted but not selected** and the trucks **quoted but not available**, with their quoted totals. Activation Notes (500 characters) gets a one-line summary; Markets (255 characters) is cut between names with a "+N more" count. The opportunity ID is written back to every hold. If Salesforce fails, the holds stand and the response says so.

**List intake.** A client ZIP list (CSV, `.xlsx`, or via Claude, PDF or email) is geocoded against the Census ZIP centroids in `lib/planning/data/` and grouped into markets by the client's DMA names. DMAs whose centres are within 30 miles are worked as one. We count ourselves in a DMA within an hour's drive, about 60 miles. Every assumption is reported, not absorbed: duplicates, rows with no DMA, PO-box ZIPs, ZIPs over 60 miles from their market's centre, probable typos (over 150 miles from the rest of their DMA), and DMAs whose ZIPs disagree. A DMA with no ZIP we can locate is shown in a red banner as **not in the quote**. A DMA is never dropped silently.

**Where Claude is used, and where it is not.** Claude (`claude-opus-5`, via `ANTHROPIC_API_KEY`) only reads lists:

- **Reading files code cannot.** A PDF, an email, or text with no ZIP column is transcribed into DMA/ZIP rows. It transcribes and never corrects, so typos still reach the flags. Clean CSV and `.xlsx` are parsed in code and never sent to Claude.
- **Reviewing the list.** It looks for what geometry cannot see: a DMA label naming a different city than its ZIPs, or a digit slip. A suggested ZIP is shown as verified only when code confirms it exists and lies within 60 miles of the DMA's other ZIPs. The rep applies a correction with one click.

Routing, truck choice and every price come only from code. Without the API key, typed markets and CSV/`.xlsx` lists still work.

## 7. What the client sees vs. what's internal

Nothing under an `_internal` key is returned on a client-authenticated route — not the margin check, and not the downstream deadhead flags. Those appear only on the staff routes (`/api/quote`, `/api/quote/hold`) and the MCP endpoint; on the client routes the same values are logged server-side instead. A client-facing response is visible in the browser network tab whether or not the UI renders it.

Every quote runs an **internal margin check** that must never reach a buyer. It compares revenue against activation-day cost plus any absorbed transport, and flags the deal for review if gross contribution falls below **42.6%**.

In the API response this is returned under a key marked `_internal` with an explicit warning attached. It is not shown in the Quote Builder UI. **Do not paste raw API output into a client-facing document** — margin, cost basis, and the gross-contribution flag are all in there.

Reference costs used internally:

- Activation day: $373.50 per truck (driver $250, fuel $50, insurance $41, repairs $25, tech $7.50)
- Transport day: $556.25 per truck (driver $250, fuel $281.25, repairs $25)

The insurance and tech figures assume **$970/truck/month spread over 20 booked days**. That 20-day assumption is an estimate, not a measurement — it is flagged as an open item in the transport spec, and if actual utilization is below 20 days the real per-day cost is higher than modeled.

---

## 8. Known gaps

Real observations from the current code. None break a quote, but each can produce a number you'll have to explain.

1. **Lead time ignores holidays.** Only weekends are excluded, so a campaign booked over Thanksgiving or Christmas week gets credited with more lead time than operations actually has — and may be absorbed into free transport on that basis.

3. **Rate agreement failures are silent** (§5). A lookup error downgrades a contract client to list pricing with no error surfaced on the quote.

4. **A rush local campaign is still free.** A 2-day campaign booked tomorrow with a truck already in market carries real cost (driver, fuel, schedule disruption) but absorbs to $0, because no truck repositions. This is a deliberate consequence of the per-truck model, not a bug — but it is an open pricing question worth revisiting.

### Resolved 2026-09-14

Market Tier 4 is now reachable: a market that is not one of the accepted top-50 DMAs is classified **Sub-DMA / small metro (20,000/truck/day)** instead of falling back to Tier 3's 40,000. The DMA match is also stricter — it previously tested substrings in both directions, so "York, PA" matched the New York DMA and jumped from tier 4 to tier 1, a 4.5x reach error.

**Lift studies will qualify less often in small markets.** That is the point: estimated reach was double the modelled figure for every market outside the top 50.

Clients can no longer self-serve a quote for a campaign starting within **2 days** (`MIN_CLIENT_LEAD_DAYS`). Internal staff are deliberately exempt. Enforced on both the client quote and client hold routes, server-side.

Single-truck feasibility now checks the campaign window, not just arrival and stranding — see §6b.

### Resolved 2026-09-11

Availability now checks arrival feasibility, measures distance from the release point rather than live GPS, and refuses bookings that would strand a committed downstream job (§6b). The same rules are enforced on the hold write paths, and mirror paths are surfaced through an audit endpoint. Previously an idle truck was offered regardless of whether it could physically arrive, and nothing looked past the campaign end date at all.

The two-transport-engine split and the calendar-vs-activation-day mismatch described in earlier versions of this document have been fixed. All five quoting surfaces now call one engine, MCP bills activation days like everything else, and the swarm gate applies everywhere. Rate-agreement transport overrides — previously ignored on the hold-request paths — now apply consistently.

## 9. Quick reference

| Variable | Value |
|---|---|
| Rate — 1 day | $1,850 / truck-day |
| Rate — 2–10 days | $1,350 / truck-day |
| Rate — 11+ days | $1,200 / truck-day |
| Standard operating day | 8 hours |
| Hour surcharge | $150 / hour over 8 (max 12) |
| Shadow fencing | 25% of base media, $5,000 floor |
| Shadow fencing CPM | $10 |
| Smart directional | $250 / truck-day |
| Device ID passback | $2,500 flat |
| Lift study | $7,500 each |
| Study minimum | 1,200,000 impressions |
| Service area radius | 250 miles |
| Miles per transport day | 450 |
| Transport day rate (billed) | $750 |
| Airfare home (one way) | $350 |
| Hotel per overnight | $210 |
| Deposit | 1 transport day ($750) / truck |
| Standard lead time | 10 business days |
| Truck count | not part of the pricing model |
| Transport absorption | 10+ activation days AND 10+ business days lead |
| Billed trucks | only those > 250mi from campaign |
| Margin review threshold | 42.6% gross contribution |

---

*Generated from `lib/pricing/{config,engine,transport,resolvers}.ts`, `lib/availabilityEngine.ts`, and the quote API routes. If pricing logic changes, it changes in `lib/pricing/` first — the MCP server is a pass-through.*
