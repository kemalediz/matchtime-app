# MatchTime × Venue Operators (Goals / Powerleague) — Commercialisation Strategy

**Date:** 2026-07-14
**Status:** Strategy document, pre-outreach. No contact made with either operator yet.
**Evidence tags used throughout:** `VERIFIED` (web-sourced, link given) · `ASSUMPTION` (my estimate, reasoning stated) · `NEEDS-BUILDING` (product work required before the claim is true).

---

## 0. Executive summary

**The hook:** *"Every week a block-booking team folds because the organiser burnt out or couldn't scrape 10 players together, you lose a ~£2,900/year recurring contract. MatchTime is the reason our club at your North Cheam site hasn't missed a week — and it runs entirely inside their WhatsApp group, so your customers actually use it."*

**Recommended model:** Free to clubs forever. Venue pays a flat per-site retention fee (~£199/site/month at scale, pilot free) for MatchTime to be the venue's promoted team-ops layer, plus we keep our existing Stripe payment margin. Do **not** build the two-sided player marketplace now; sell retention first, earn the demand-signal story later.

**The pilot ask:** One site — Goals Sutton (North Cheam), where Sutton FC already runs live on MatchTime with real weekly Stripe payments. 90 days, 10–15 block-booking teams onboarded via the venue, zero cost to Goals. Success = squad-fill rate, cancellation rate, and slot retention vs. the site's baseline.

**Biggest risk:** Attribution. Block-booking churn is slow and noisy; proving *MatchTime caused* retention inside 90 days is hard, and both operators are PE-owned, loss-making or pruning sites, with little innovation bandwidth. The venue channel is worth **one cheap, time-boxed pilot** — not a strategy bet. Direct-to-club product-led growth remains the primary engine; the venue channel is a distribution multiplier if (and only if) the pilot converts.

---

## 1. The two targets — verified picture

### Goals Soccer Centres

- **Ownership:** `VERIFIED` — Acquired October 2019 out of a pre-pack administration (~£27m) by **Northwind 5s Limited**, a vehicle of **Inflexion Private Equity + Soccerworld**, after an accounting scandal in which profits may have been overstated by ~£40m since 2009. Delisted from AIM. ([Wikipedia](https://en.wikipedia.org/wiki/Goals_Soccer_Centres), [Scottish Financial News](https://www.scottishfinancialnews.com/articles/goals-soccer-centres-bought-by-soccerworld-for-27m-in-pre-pack-administration))
- **Scale:** `VERIFIED` — ~43–45 UK sites plus 4 in Los Angeles (US arm merged with Sofive). ([goalsfootball.co.uk](https://www.goalsfootball.co.uk/), [goals-soccer.com](https://www.goals-soccer.com/news/sofive-goals-merger))
- **Current pressure:** `VERIFIED` — As of Feb 2026, Northwind 5s is **marketing four venues for sale** (Aberdeen, Bradford, Leicester, Wimbledon; the Aberdeen site turned over £484k). ([Press & Journal](https://www.pressandjournal.co.uk/fp/business/6148084/aberdeen-football-venue-up-for-sale-as-part-of-3-65-million-package/)) Portfolio pruning = under-performing sites are being cut, not fixed. Revenue defence at the remaining sites is exactly the conversation they're in.
- **Business model:** `VERIFIED` — pitch hire (Goals Sutton: **£45.40–£63.54/hr**, per [Playfinder](https://www.playfinder.com/london/venue/goals-sutton)), block bookings ("same pitch, same time every week, £0 upfront, pay weekly"), in-house leagues, kids parties/camps, bar revenue.
- **Tech history — the killer precedent:** `VERIFIED` — Goals launched its own team-organiser app **in 2014**: invite/select/manage players, digital match-fee payments, and a "player blast" feature to replace last-minute drop-outs from a local player pool. The board said it would "increase revenue significantly by reducing cancelled matches." ([The Drum, Sep 2014](https://www.thedrum.com/news/2014/09/03/goals-five-side-organisation-app-replace-drop-outs-and-take-digital-pitch-payments)) That app is dead; today's Goals site pushes plain online booking. **Goals has already validated our thesis and already failed at our product — because it required every player to download and live in a venue's app. MatchTime's WhatsApp-native design is precisely the fix for why their attempt died.** This is the single most useful fact in this document: they don't need convincing that drop-outs and cancellations cost them money — their own board said so publicly. They need convincing the adoption problem is solved.

### Powerleague

- **Ownership:** `VERIFIED` — Acquired **June 2025 by Broadsword Investment Management** (UK PE, founded 2024, real-estate-backed growth focus); management retained. Previously: Patron Capital from 2009, **CVA restructuring in 2018**. ([Powerleague announcement](https://www.powerleague.com/blog/powerleague-acquired-by-broadsworth-investment-management), [PE Insights](https://pe-insights.com/broadsword-acquires-powerleague-to-fuel-uk-multi-sport-expansion/), [Wikipedia](https://en.wikipedia.org/wiki/Powerleague))
- **Scale & financials:** `VERIFIED` — ~43–44 owned venues (UK, Ireland, Netherlands; 12 in Greater London, 10 in Greater Manchester); league operations spanning **350+ locations** including managed third-party venues (football + netball). FY2024: **turnover £38.1m, pre-tax loss £4.26m**, revenue +14.5%, EBITDA +8.3%. ([TheBusinessDesk](https://www.thebusinessdesk.com/northwest/?p=2153267))
- **Strategic direction:** `VERIFIED` — **Padel conversion**: 18 padel clubs / 76 courts inside existing sites by 2026. ([PE Insights](https://pe-insights.com/broadsword-acquires-powerleague-to-fuel-uk-multi-sport-expansion/)) Read this correctly: Powerleague's answer to underutilised football capacity is **capex to rip it out and re-lay it as padel**. Every football slot that stays reliably sold is a pitch that doesn't need a £100k+ conversion to justify itself. That cuts both ways for us (see §10).
- **Tech:** `VERIFIED` — Own booking app (iOS/Android, built with Propel Tech / Plug & Play), block bookings at discounted rates, a **Split Payments** feature (organiser generates a payment link from "My Bookings", sees who's paid), membership scheme, Quick Pay. ([powerleague.com/split-payment-faq](https://www.powerleague.com/split-payment-faq), [Propel Tech](https://propeltech.co.uk/work/powerleague/)) So Powerleague will say "we already do payments." The honest rebuttal: a payment link on a booking page solves *the organiser's card being charged*; it does nothing about attendance, chasing, benches, drop-out replacement, or the 4pm "we're only 7" cancellation. Their split-pay requires the organiser to go to their app and push links out per booking; MatchTime lives where the team already talks, every day.

### Market context

- `VERIFIED` — ~1.5M UK adults play small-sided football weekly; small-sided is the largest and fastest-growing chunk of adult football; 96% of councils report insufficient 3G pitch supply. ([5-a-side.com](https://www.5-a-side.com/uncategorized/how-many-people-play-5-a-side/), [Football Foundation insight report](https://footballfoundation.org.uk/sites/default/files/2020-07/Small-sided%20Football%20Insight%20Report%20May%202018.pdf))
- `VERIFIED` (industry-source, directional) — Venue-software vendors consistently describe the same two pains: peak (Mon–Thu evening) sells itself while off-peak is a dead zone, and **late team cancellations are unresellable lost revenue** ("the 4pm phone call on match day when two players drop out and the team can't make numbers"). ([Bookteq](https://www.bookteq.com/blog-multi-site-sports-venue-reporting/), [AllBooked](https://www.allbooked.com/insights/sports-pitch-reservation-system))

### Competitive landscape — is anyone already the "venue-promoted ops tool"?

| Player | What they are | Venue relationship | Threat to us |
|---|---|---|---|
| **Spond** | Free team-management app (3M+ MAU, strong in UK grassroots); monetises via payment transaction fees. `VERIFIED` ([Spond help](https://get.spond.help/l/en/article/to9uh3a1js-what-is-spond-s-business-model)) | None — sold to clubs/parents, not venues | Feature-comparable on comms/payments but **app-download model**, aimed at junior/committee clubs. Not in the casual-5s WhatsApp niche. |
| **Footy Addicts** | Pay-and-play marketplace, 100k+ users, host books pitch and fills it with strangers; platform takes a cut. `VERIFIED` ([footyaddicts.com](https://footyaddicts.com/)) | Indirect — hosts hire venue slots, so venues get fill revenue | The incumbent for "fill an empty slot with randoms." They own the casual-player pool. **Do not fight them on marketplace; they've spent a decade building liquidity.** They don't do *team retention* at all. |
| **Playfinder / Bookteq** | Booking marketplace + venue booking SaaS, 600+ venue partners. `VERIFIED` ([playfinder.com](https://www.playfinder.com/), [bookteq.com](https://www.bookteq.com/)) | Deep — they ARE venue software | Distribution/booking layer, zero team-ops. Potential *partner* (they resell to venues already) more than competitor. |
| **Pitchbooking / AllBooked / Vamos** | Venue management SaaS | Deep | Same as above — booking admin, not squad ops. |
| **Goals' own 2014 app** (dead) / **Powerleague app + Split Pay** | Venue-built organiser tools | Native | Proof the venues *want* this to exist; proof they can't build consumer adoption themselves. |

**Conclusion:** the "venue-promoted, WhatsApp-native team-ops layer" seat is **empty**. Spond owns committee-run clubs, Footy Addicts owns strangers-football, Playfinder owns booking. Nobody owns *keeping an existing casual team alive*, which is the thing venues' recurring revenue actually stands on.

---

## 2. The venue's actual problem, in their language

A commercial director at Goals or Powerleague thinks in: **slot yield** (revenue per pitch-hour), **peak occupancy**, **off-peak fill**, **block-booking book** (the recurring contract base), **league team count**, and **churn of that book**.

The unit economics of one block booking (`ASSUMPTION`, built from verified prices):

- Goals Sutton pitch hire is £45.40–£63.54/hr (`VERIFIED`). Call a weekly evening block **~£55/week ≈ £2,860/year** of contracted, zero-CAC, peak-time revenue.
- A typical Goals site has ~10 pitches (Sutton: 9× 5-a-side + 1× 7-a-side, `VERIFIED`). Peak window ≈ 6–10pm × Mon–Thu ≈ 160 peak pitch-hours/week. If block bookings + leagues fill ~60% of that (`ASSUMPTION` — industry-consistent, unverified), the recurring book at one site is ~£250–300k/year.
- **How blocks die** (`ASSUMPTION`, but matches how every organiser describes it, and matches what Goals' own 2014 board statement implied): not by a decision to quit — by decay. The organiser chases 15 people every week in WhatsApp; three straight weeks of scraping 8 players; someone doesn't pay for a month; the organiser stops booking. The venue sees it only as "the Tuesday 8pm slot went quiet" — after the fact, when the slot re-sells slowly or not at all off-peak.
- If a site holds ~80–100 block/league teams and loses even 15–20%/year to organiser-side decay (`ASSUMPTION` — no public churn data exists; this must be pilot-measured), that's **£40–70k/year per site** of revenue that walks out the door for reasons that have nothing to do with the venue's product — and everything to do with the organiser's unpaid admin job.
- Second-order losses, both `VERIFIED` as industry pains: late cancellations (unresellable pitch-hours) and no-shows. Powerleague's split-payments FAQ and Goals' 2014 app are both artefacts of the operators *knowing* this.

**What is verified vs. estimated, bluntly:** pitch prices, site counts, financials, padel pivot, the 2014 Goals app rationale — verified. Block churn rate, block share of peak, per-site block count — estimates that the pilot exists to measure. Say exactly this in the room; commercial directors respect "we'll measure it at your site" over invented benchmarks.

---

## 3. The pitch narrative

**One-line hook:**
> "You lose block bookings when organisers burn out — we're the reason a team at your North Cheam site hasn't missed a booking or a payment in months, and none of their players had to download anything."

**30-second version:**
> "Your recurring revenue stands on a few hundred volunteer organisers doing a miserable weekly job in WhatsApp: chasing IN/OUTs, filling drop-outs, collecting money. When one burns out or a squad keeps coming up short, the block dies and you lose a couple of grand a year of peak-time contract — and you find out after the fact. MatchTime is a bot that joins the team's existing WhatsApp group and does that whole job: attendance, bench and drop-out replacement, balanced teams, and per-player payment collection through Stripe. No app, no behaviour change — that's why it actually gets used, and it's why your own 2014 attempt at this didn't. It's already running live, with real money, for a team that plays at Goals North Cheam every week. We want to prove at that one site that block bookings on MatchTime don't churn — then talk about the other 40."

Notes on the framing:

- Lead with **their P&L** (block retention), not our feature list. Features appear only as the causal mechanism.
- For **Goals**, invoke the 2014 app respectfully: "you were right ten years early; the missing piece was adoption, and WhatsApp is the answer." Nothing disarms "why would this work" like "you already believed it."
- For **Powerleague**, the angle is padel-adjacent: "before you convert a pitch to padel, be sure the football demand is really gone — we keep football slots sold *and* we can tell you, per slot, which teams are structurally short and which slots are genuinely dying." Broadsword is a real-estate-yield investor; talk in yield per square metre.
- Never say "app." Say "it lives in the WhatsApp group they already have."

---

## 4. Benefit case — feature → venue outcome, causal chain

| MatchTime feature (all LIVE unless flagged) | Organiser/team effect | Venue outcome |
|---|---|---|
| IN/OUT attendance tracking + chasing + capacity cap | Organiser's weekly admin drops from hours to minutes; squad status visible days out | **Organiser burnout ↓ → block-booking churn ↓** (the headline) |
| Bench/waitlist: drop-out offered to whole bench, first-claim wins | Late drop-outs auto-backfilled from the team's own fringe | **Fewer sub-10-player weeks → fewer late cancellations → fewer unresellable pitch-hours** |
| Stripe per-match payments + auto-chasing | Organiser never fronts money or chases debtors; players pay per match | **Organiser's #1 quit-reason removed**; teams financially self-sustaining → blocks persist |
| Elo team balancing + MoM voting + ratings | Games stay competitive and fun; banter engine | Stickiness — even games are why people come back weekly (`ASSUMPTION` on causality, but low-risk claim) |
| Recurring fixture auto-generation, format switching (5s↔7s) | Next week's match exists by default; team can downshift format instead of folding | **A short squad becomes a format change, not a cancellation** — directly protects the slot |
| Guest adds (member vouches a friend in-group) | Squads organically replenish | Team lifespan ↑; new players enter the venue's orbit at zero CAC to the venue |
| Real-time "who's short, days in advance" signal | — | **Unique demand-side data no booking system has** (see §6 for what it takes to monetise; don't oversell in meeting 1) |
| Self-onboarding via adding bot to a group (built, behind flag) | Venue staff can onboard a team by sharing one link/QR | **Makes venue-led distribution operationally free** — flip the flag before any pilot |
| Multi-tenant + admin dashboard (club-facing today) | — | Foundation for the venue-facing report (`NEEDS-BUILDING`, small — §7) |

The causal chain to say out loud: *organiser admin pain → organiser quits or squad shortfalls compound → block booking dies → peak slot re-sells slowly or never → lost yield.* MatchTime attacks the first two links; everything downstream is arithmetic.

---

## 5. Commercialisation models — the menu, then the decision

**(a) Venue-paid retention SaaS (per active group, or flat per site).** Venue pays ~£15–25/active team/month or ~£199–399/site/month; free to clubs. *Pros:* aligns exactly with the retention story; venue promoting it is in their own interest; clean B2B revenue; club-side free keeps adoption frictionless. *Cons:* attribution burden on us; slow enterprise sale to two PE-owned, cash-tight operators; per-team pricing invites "prove each team was savable." *Demands:* venue report + pilot evidence. *Sell difficulty:* medium — but the pilot de-risks it.

**(b) Rev-share on player payments (we keep/split Stripe margin).** *Pros:* zero-price barrier to the venue; scales with usage. *Cons:* our payment margin on a £5–7 match fee is pennies; a share of pennies is not a business, and it gives the venue no reason to *promote* — they'd be indifferent. Keep our existing payment margin as a secondary stream, but it can't be the venue's incentive.

**(c) Free-to-club + venue-*sponsored* ("Powered by Goals" inside the group).** Venue pays for co-branding: bot posts venue-branded rosters, venue offers (bar deals, kids parties) to a warm, weekly-active audience. *Pros:* reframes cost as marketing spend (budget exists); the WhatsApp group is a marketing channel venues cannot reach today. *Cons:* smells like adtech; clubs may resent promos; hard to price. *Verdict:* a **sweetener inside (a)**, not a standalone model — "your brand in the group, your bar offer after the roster posts" is a genuinely nice line item.

**(d) Marketplace fill-the-pitch fee (we surface short squads / spare slots to a player pool, take a per-fill fee).** *Pros:* the sexiest story; unique data. *Cons:* it's a **two-sided marketplace we don't have either side of** — no player pool, no booking integration (`NEEDS-BUILDING`, large), and Footy Addicts already owns casual-fill liquidity. Cold-start on marketplace liquidity kills startups. *Verdict:* **trap if attempted now.** The realistic v1 is not a marketplace at all — it's *within-venue guest surfacing* (§7), which needs no liquidity we don't already create.

**(e) White-label ("Goals Teams, powered by MatchTime").** *Pros:* venues love owning the brand; bigger contract. *Cons:* per-operator forks, we become an outsourced dev shop, exclusivity demands, and it resurrects their 2014 failure with our plumbing but their (weak) consumer trust. *Verdict:* refuse at this stage; revisit only for a serious cheque.

**(f) Data/insights licensing (occupancy-risk analytics).** *Cons:* no data scale yet; GDPR care needed; analytics without the ops layer is a report nobody pays for. *Verdict:* later, as a line inside (a).

**(g) Pure B2C/PLG with venues as unpaid distribution.** Ask venues to promote us for free because full teams cancel less. *Pros:* nothing to negotiate. *Cons:* "free" things get zero push from site GMs; no accountability either side. *Verdict:* this is the fallback if (a) won't close — and honestly it may be the *opening* posture for the pilot (free pilot = model (g) for 90 days, converting to (a)).

### Recommendation (decisive)

**Model (a), flat per-site, with (c) as a sweetener and our Stripe margin kept quietly as (b).** Specifically:

- **Pilot:** free, one site, 90 days (see §9).
- **Post-pilot price:** **£249/site/month** (`ASSUMPTION` — a guess, anchored thus: one retained block booking pays for a full year of the fee; ~£130k/year at full Goals estate coverage, which is a rounding error against a single site's revenue but a real SaaS contract for us). Offer £199 at estate-wide commitment, £399 single-site à la carte. Do not price per-team in the contract — per-team pricing creates a perverse incentive for the venue to limit onboarding; flat per-site makes the venue want *every* team on it.
- Club-side stays free forever, venue or no venue. Venues are a channel, not a dependency.

---

## 6. Why would a venue actively PROMOTE it? (the crux)

Be honest about the org reality: a site **General Manager** is measured on site revenue, occupancy, and league numbers, and personally suffers the Friday-4pm cancellation call and the "who didn't pay for their league match" chase. Head office (commercial director) is measured on estate revenue and churn. The pitch must give both a reason:

1. **For the GM:** MatchTime makes their block book self-defending, and — crucially — it costs them *zero incremental work* once self-onboarding is on: hand a QR card to the organiser at booking, done. GMs will promote something that reduces their own phone calls. The promotion ask must be that small: **QR card at reception + one line in the block-booking confirmation email + GM mentions it when a team books.** Anything requiring a process change dies.
2. **For head office:** an estate-level story — "your block-booking book, instrumented." The monthly venue report (§7) is the artefact: which teams are thriving, which are structurally short (at-risk revenue flagged *weeks* before the slot goes quiet), payment health. Today they have zero visibility between "slot booked" and "slot cancelled." We give them a leading indicator on their single most valuable revenue line. That's a head-office reason to *mandate* the QR cards.
3. **The at-risk alert is the killer promotion incentive:** when MatchTime sees a group chronically short, the venue gets a heads-up while the block is still alive — time for the GM to intervene (offer a league merge, a smaller format, connect them with another short team at the same site). No booking system, including their own apps, can see this. (`NEEDS-BUILDING`: the alert is a small feature; the *signal* already exists in our data.)
4. **Co-branding sweetener:** "Powered by Goals Sutton" on the roster post; venue bar offer after MoM voting. Their brand inside the most-read message of the team's week.
5. **Exclusivity:** they will ask. Give *category* exclusivity per pilot period only ("we won't onboard Powerleague sites during the Goals pilot") — never permanent, never free. Permanent exclusivity is for a paid estate-wide contract.
6. **Pilot economics for them:** free, one site, we do the onboarding, they contribute a QR stand and an email. The "no" has to be harder to justify than the "yes."

What we must NOT ask for: access to their booking system, their customer database, app changes, or head-office IT involvement. Every one of those turns a GM conversation into a 9-month procurement.

---

## 7. What we'd need to build — ranked by leverage ÷ effort

**Pitch it TODAY with what exists (nothing to build):**
- Core ops, payments (live with real money), recurring fixtures, bench, balancing, guest adds, multi-tenant, club dashboard, and the Sutton FC @ Goals North Cheam reference. The first meeting needs zero new code.

**Before/at pilot start (small, high leverage):**
1. **Flip the self-onboarding flag** and harden it for "venue hands organiser a QR" flow (the code exists behind `ONBOARDING_AUTOSTART`). Highest leverage per unit effort in the company right now — venue distribution is worthless if onboarding needs us in the loop.
2. **Venue monthly report** — a PDF/email per site: teams active, fill rate per team, matches at risk, matches saved (bench fills), payment completion. This is the retention *proof artefact* and the thing head office forwards internally. v1 is a scheduled script over data we already store — days, not weeks.
3. **Co-branded onboarding kit** — QR card + one-page explainer + the confirmation-email paragraph. Marketing collateral, not engineering.

**During pilot (medium):**
4. **At-risk group alert** to the venue GM (WhatsApp/email): "Tuesday 8pm team has been ≤8 players 3 weeks running." Small feature, big story.
5. **Read-only venue dashboard** (web) — only if the pilot converts; the PDF report may be enough for a 44-site deal. Don't gold-plate before revenue.

**Explicitly NOT now (large, deferrable):**
6. **Booking-system integration** — only valuable at estate-wide contract stage, and their systems are bespoke (Propel Tech etc.). Let the paid contract fund it.
7. **Cross-group player pool / marketplace** — see §5(d). The one cheap sliver worth prototyping *if the pilot thrives*: **within-venue guest surfacing** — when Group A at Goals Sutton is short on Tuesday, offer the slot to opted-in players from other MatchTime groups *at the same venue*. No public pool, no strangers problem, liquidity comes from our own pilot density. Still `NEEDS-BUILDING` and still phase 2.
8. **WhatsApp Business API migration** — not venue-facing, but flagged in §10: enterprise credibility and platform risk both point at getting off any unofficial client before an estate-wide contract's due diligence.

---

## 8. Objections and rebuttals (the hard ones)

- **"Why is our customers' team admin our problem?"** — Because it's your revenue's single point of failure. Your block book is carried by unpaid volunteers; when one quits, you lose ~£2,900/year and you find out last. You already agreed — your board said exactly this when you launched your organiser app in 2014 [Goals]. / You built Split Payments because you know organiser friction kills bookings [Powerleague].
- **"We have our own app / Split Payments."** — Your app solves booking and paying *you*. It doesn't get 14 blokes to confirm by Thursday, backfill two drop-outs on Friday, or chase the guy who owes three weeks. And it requires every player to install it — which is why organiser apps in this space (including Goals' own) never held adoption. We require zero installs; the group already exists.
- **"GDPR / our customers' data."** — Players interact with MatchTime under their club's arrangement, in their own group; the venue receives **aggregate, anonymised team-level stats only** (fill rates, at-risk flags) — no names, no phone numbers, ever. A one-page DPA covers it. (`NEEDS-DOING`: draft that DPA before meeting 2; also be ready to state our own controller/processor position cleanly.)
- **"We don't want to depend on a startup." / "What if you disappear?"** — Nothing breaks. The WhatsApp group is theirs, the booking relationship is yours, payments run on the club's own Stripe. If MatchTime vanished tomorrow, teams revert to manual — no lock-in, no data hostage. That's the *point* of living in WhatsApp rather than replacing it.
- **"Our organisers already manage fine on WhatsApp."** — The ones who survived do. You never meet the ones who quit; you just see slots go quiet. Ask your GMs how many "solid" Tuesday blocks evaporated in the last 12 months and whether they saw any of them coming.
- **"Footy Addicts / Playfinder already do this."** — They fill *empty* slots with strangers or route *new* bookings. Nobody keeps an *existing team* alive. Different layer; arguably complementary to both.
- **"What does it cost us?"** — Pilot: nothing. After: less per site per month than one hour of peak pitch hire per week, and one retained block pays for the year.
- **"Why should we push a third-party tool at our customers?"** — You push whatever keeps them booking. You co-brand it; your customers experience it as your site being the best-run place they play. And during the pilot we're exclusive to you.

---

## 9. Concrete pilot proposal — Goals Sutton (North Cheam)

**The asset:** Sutton FC plays weekly at Goals North Cheam and runs 100% on MatchTime — attendance, benching, team balancing, and **real Stripe payments every week** since June. (`VERIFIED` internally — this is our production system; Goals Sutton facility details verified via [Playfinder](https://www.playfinder.com/london/venue/goals-sutton): 9× 5-a-side + 1× 7-a-side, £45.40–£63.54/hr.)

**The ask (small enough to say yes to):**
- One site, 90 days, free.
- Goals Sutton onboards **10–15 block-booking teams**: QR card handed at booking/renewal, one paragraph in the block confirmation email, poster at reception. We (MatchTime) run a launch evening at the site and handle all onboarding — self-onboarding flag on.
- Goals nominates one contact (site GM is fine). Monthly report delivered to GM + one head-office recipient.
- Category exclusivity for the pilot period (we don't onboard Powerleague sites till it ends).

**What we measure (agreed up front, in the one-pager):**
1. **Squad-fill rate**: % of matches reaching target numbers, vs. each team's first-two-weeks baseline.
2. **Late cancellations**: team-initiated cancellations <48h, on-MatchTime teams vs. site baseline (GM's log).
3. **Drop-outs auto-recovered**: bench fills per month (our data — the "saved pitch-hours" number).
4. **Payment health**: % of match fees collected within 48h.
5. **Organiser NPS** + a quote bank.
6. **Block retention**: % of pilot blocks renewed at day 90 (directional only in 90 days — say so honestly; it's the metric the *estate deal* gets judged on over 12 months).

**Success looks like:** ≥10 teams active, fill rate up meaningfully (target +10pts, `ASSUMPTION`), ≥5 documented "match saved by bench-fill" incidents, zero pilot blocks lost, organiser NPS that produces quotable lines. **Convert:** estate rollout at £199/site/month (year-1 commitment) or £399/site à la carte, venue report included.

**Kill criteria (ours):** <6 teams adopt despite venue promotion, or organisers churn off the bot, or the GM won't do even the QR-card motion — any of those and the venue channel thesis is damaged (see §10).

---

## 10. Outreach plan

**Sequence (bottom-up, reference-first):**
1. **Goals Sutton site GM** — warm, in person: Kemal (or the Sutton FC organiser, better still) asks for 20 minutes at the site. "One of your Tuesday teams runs on this; here's what it does; can we show you?" Goal: GM enthusiasm + name of the right head-office person. Site GMs are findable via the club page / LinkedIn (`NEEDS-DOING`: identify by name — do not cold-email info@).
2. **Goals head office** — Commercial Director / Head of Sales & Marketing / CEO at Northwind 5s (Glasgow HQ). Titles verified to exist in kind, individuals `NEEDS-DOING` on LinkedIn. Warm intro from the GM if step 1 lands; otherwise direct LinkedIn with the email below.
3. **Powerleague second**, only after Goals pilot starts (or if Goals stalls >6 weeks): Commercial/Revenue Director, or CEO's office; Broadsword deal press names retained management (`NEEDS-DOING`: names via LinkedIn). Angle: padel-era slot-yield + "we're live at a Goals site" competitive nudge — the duopoly dynamic works for us.
4. In parallel, keep direct-to-club growth running; the venue channel must never gate club acquisition.

**Draft outreach message (LinkedIn/email to a commercial director — 120 words):**

> Subject: The Tuesday 8pm block at your North Cheam site
>
> Hi [Name] — one of the weekly teams at Goals North Cheam runs its entire operation through MatchTime, a bot that lives inside the team's WhatsApp group: attendance, drop-out backfill, balanced teams, and per-player payment collection (real money, every week, via Stripe).
>
> Block bookings die when volunteer organisers burn out — and you find out after the slot goes quiet. MatchTime removes that job. No app for players to download, which is why it actually sticks (as you know from the 2014 Goals organiser app).
>
> I'd like to run a free 90-day pilot at North Cheam — 10–15 block teams, and you get a monthly report showing fill rates and at-risk slots. 20 minutes this week or next?

(For Powerleague, swap the 2014 line for: "Split Payments solves paying you; this solves the team turning up.")

---

## 11. Honest risk assessment — the strongest reasons this fails

1. **Attribution is genuinely hard.** Churn is annual-cycle and noisy; a 90-day pilot yields leading indicators (fill rate, saved matches), not proof of retained revenue. A sceptical CFO can wave it away. *Mitigation:* agree metrics up front; sell the leading indicators + the GM's lived experience. *Reality:* some buyers will never be satisfied.
2. **Both buyers are structurally distracted.** Goals: post-fraud PE ownership, currently *selling sites* — cost-out mode, and pre-pack-scarred management can be deeply conservative about partnerships. Powerleague: new PE owner (month 13), loss-making, and their strategic energy is going to **padel conversion** — a competing answer to the same underutilisation problem that involves real estate (their investor's comfort zone), not software. We might be the cheaper answer, or we might be noise against a £-millions capex programme.
3. **Enterprise sales cycle vs. our size.** Even a "free pilot" can take a quarter to say yes to. Meanwhile the same effort spent on direct-to-club PLG (self-onboarding + WhatsApp virality — every guest add and opponent team is exposure) compounds for us alone.
4. **The GM promotion motion may just not happen.** Free things get zero push. If QR cards sit in a drawer, the pilot dies of apathy, not rejection. *Mitigation:* we run the launch evening ourselves; the Sutton FC organiser evangelises peer-to-peer.
5. **Platform risk (internal, must be owned before estate contracts):** the bot rides WhatsApp; any due-diligence process will ask about compliance with WhatsApp's terms and continuity if the account is banned. Migrating to (or having a credible plan for) the official WhatsApp Business API is a prerequisite for signing a 44-site contract, and its interaction model (template/session messages) is a real design constraint to scope early.
6. **Venue channel could even be the wrong customer:** the value accrues first to *organisers*, who adopt happily for free; the venue is a second-order beneficiary being asked to pay. Second-order beneficiaries are notoriously slow buyers.

**Walk-away triggers — go pure direct-to-club if:** (a) the Goals pilot can't get a yes within ~8 weeks of the GM meeting; (b) the pilot runs but <6 teams adopt despite genuine venue promotion; (c) either operator demands white-label/exclusivity/IP terms as a precondition; or (d) direct-to-club growth is compounding fast enough that venue-channel effort has worse marginal return. The venue channel is one free pilot's worth of effort and collateral — cap the investment there until it earns more.

**Bottom line:** the strategic insight survives contact with the evidence — *retention + utilisation* is the right frame, the seat is empty, and Goals' own 2014 app is documentary proof the venues want this and couldn't build the adoption themselves. But it's a channel bet, not the company. Run the North Cheam pilot hard and cheap; let direct-to-club remain the engine; let the marketplace fantasy wait until density makes it a feature instead of a company-killer.

---

## Appendix: source list

- Goals ownership/scandal: [Wikipedia — Goals Soccer Centres](https://en.wikipedia.org/wiki/Goals_Soccer_Centres); [Scottish Financial News — £27m pre-pack](https://www.scottishfinancialnews.com/articles/goals-soccer-centres-bought-by-soccerworld-for-27m-in-pre-pack-administration); [North East Times — 750 jobs saved](https://netimesmagazine.co.uk/business/750-jobs-saved-as-goals-soccer-centres-sold-to-northwind-5s-limited/)
- Goals site sales Feb 2026: [Press & Journal](https://www.pressandjournal.co.uk/fp/business/6148084/aberdeen-football-venue-up-for-sale-as-part-of-3-65-million-package/) (headline/snippet only — paywalled; verify details before quoting figures in a meeting)
- Goals 2014 organiser app: [The Drum, 2014-09-03](https://www.thedrum.com/news/2014/09/03/goals-five-side-organisation-app-replace-drop-outs-and-take-digital-pitch-payments)
- Goals Sutton (North Cheam) facility/pricing: [Playfinder — Goals Sutton](https://www.playfinder.com/london/venue/goals-sutton)
- Powerleague/Broadsword: [Powerleague announcement](https://www.powerleague.com/blog/powerleague-acquired-by-broadsworth-investment-management); [PE Insights](https://pe-insights.com/broadsword-acquires-powerleague-to-fuel-uk-multi-sport-expansion/); [TheBusinessDesk — FY24 £38.1m / −£4.26m](https://www.thebusinessdesk.com/northwest/?p=2153267); [Wikipedia — Powerleague](https://en.wikipedia.org/wiki/Powerleague)
- Powerleague tech: [Split Payment FAQ](https://www.powerleague.com/split-payment-faq); [Propel Tech case study](https://propeltech.co.uk/work/powerleague/)
- Competitors: [Spond business model](https://get.spond.help/l/en/article/to9uh3a1js-what-is-spond-s-business-model); [Footy Addicts](https://footyaddicts.com/); [Playfinder](https://www.playfinder.com/); [Bookteq](https://www.bookteq.com/)
- Market/venue pains: [5-a-side.com participation](https://www.5-a-side.com/uncategorized/how-many-people-play-5-a-side/); [Football Foundation insight report](https://footballfoundation.org.uk/sites/default/files/2020-07/Small-sided%20Football%20Insight%20Report%20May%202018.pdf); [Bookteq multi-site reporting blog](https://www.bookteq.com/blog-multi-site-sports-venue-reporting/); [AllBooked pitch reservation guide](https://www.allbooked.com/insights/sports-pitch-reservation-system)
