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

### Swarm gate

If a campaign requests **more trucks than the nearest market's base concurrency**, the quote exits automated pricing entirely and returns **manual quote** — "a rep will follow up." This applies on every surface, including client self-serve. The limit is per-market, read from the accepted-markets table; there is no global truck-count limit.

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

**Rule 2 — it is free.** Nothing else is booked during the campaign itself.

**Rule 3 — it does not strand its next job.** After the campaign, the truck must still reach whatever it is already committed to. If the next job is in Seattle starting the day after ours ends, and Seattle is 5 transport days away, taking this booking would break a job you have already sold.

### Where the truck departs from

Distance is measured from the **release point** — where the truck will actually be when it becomes free — not from where its GPS reads today. A truck working Miami through the 12th is a Miami truck for a campaign starting the 14th, even if it is currently parked in Dallas. The same distance drives both the feasibility check and the transport charge, so they can never disagree.

If there is no prior job, live GPS is used. If neither resolves, the truck is reported as `UNKNOWN_ORIGIN` rather than quietly dropped.

### Overrides

A **hard commitment** (`HOLD`, `COMMITTED`, or scheduled program work) can never be stranded — the truck is excluded, full stop.

A **soft hold** (`ATT_SOFT`) may be displaced. Those trucks are returned flagged as `requiresOverride`: they are never auto-selected by a quote or hold flow, but a rep can see them and make the call.

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
| Salesforce push | writes, never blocked |
| ATT sync | writes, never blocked |

The last two **mirror** bookings that already exist upstream. Refusing them would drop a record the source system believes is real, so they write unconditionally and are surfaced instead by:

```
GET /api/holds/infeasible
```

That endpoint recomputes feasibility across every active hold and returns the ones that cannot be served, with the reason. It is deliberately **not** a stored flag on the hold row — feasibility is a property of the whole chain, so a flag written at insert time is wrong the moment a neighbouring job moves. A hold booked cleanly in March can become infeasible in April because something else changed around it; only recomputing catches that.

If the feasibility lookup itself errors, the hold is allowed through and the error is logged. A logistics service being down should not stop the business taking a booking.

### Why transit days are not blocked on the calendar

Feasibility is recomputed from the stored job chain every time, so a second campaign evaluating the same truck sees the first campaign as a job and has to route around it. Writing transit days into the calendar would be **derived data** — correct only for the chain that existed when it was written, and stale the moment a job moves or cancels. Blocking transit on the grid is a display question, not a correctness one.

## 7. What the client sees vs. what's internal

Every quote runs an **internal margin check** that must never reach a buyer. It compares revenue against activation-day cost plus any absorbed transport, and flags the deal for review if gross contribution falls below **42.6%**.

In the API response this is returned under a key marked `_internal` with an explicit warning attached. It is not shown in the Quote Builder UI. **Do not paste raw API output into a client-facing document** — margin, cost basis, and the gross-contribution flag are all in there.

Reference costs used internally:

- Activation day: $373.50 per truck (driver $250, fuel $50, insurance $41, repairs $25, tech $7.50)
- Transport day: $556.25 per truck (driver $250, fuel $281.25, repairs $25)

The insurance and tech figures assume **$970/truck/month spread over 20 booked days**. That 20-day assumption is an estimate, not a measurement — it is flagged as an open item in the transport spec, and if actual utilization is below 20 days the real per-day cost is higher than modeled.

---

## 8. Known gaps

Real observations from the current code. None break a quote, but each can produce a number you'll have to explain.

1. **Market Tier 4 is unreachable.** The 20,000-impression tier exists in the config, but automatic market lookup only ever returns tiers 1, 2, or 3 — unmatched markets fall back to Tier 3 (40,000). Small markets are therefore credited with **double** the impressions their tier implies, which can push a campaign over the 1.2M lift-study threshold it shouldn't clear.

2. **Lead time ignores holidays.** Only weekends are excluded, so a campaign booked over Thanksgiving or Christmas week gets credited with more lead time than operations actually has — and may be absorbed into free transport on that basis.

3. **Rate agreement failures are silent** (§5). A lookup error downgrades a contract client to list pricing with no error surfaced on the quote.

4. **A rush local campaign is still free.** A 2-day campaign booked tomorrow with a truck already in market carries real cost (driver, fuel, schedule disruption) but absorbs to $0, because no truck repositions. This is a deliberate consequence of the per-truck model, not a bug — but it is an open pricing question worth revisiting.

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
| Swarm gate | > market base concurrency → manual quote |
| Transport absorption | 10+ activation days AND 10+ business days lead |
| Billed trucks | only those > 250mi from campaign |
| Margin review threshold | 42.6% gross contribution |

---

*Generated from `lib/pricing/{config,engine,transport,resolvers}.ts`, `lib/availabilityEngine.ts`, and the quote API routes. If pricing logic changes, it changes in `lib/pricing/` first — the MCP server is a pass-through.*
