// One-off (2026-11-09): re-offer tonight's Monday night vets game to the 4
// pool players whose offers the 6-hour expiry ended as "ignored" overnight.
// Kemal approved re-offering these same 4. The offer rows are REOPENED in
// place (PoolOffer is unique on matchId+userId) and a fresh "pool-offer"
// platform job is queued for each through the same helpers sendWave uses
// (round.ts): poolOfferText, poolOfferPath, buildPoolManageLink,
// queuePlatformDm. The Pi then delivers it and onPoolOfferJobSent stamps
// sentAt and expiresAt as normal. Old platform job rows are only read.
//
// Dry run (default) writes nothing. --apply writes, per offer, in one
// transaction, compare-and-set on outcome = 'ignored' (so a second run
// queues nothing).
//
//   cd repo; set -a; source .env; set +a; npx tsx scripts/_tmp-reopen-vets-offers.ts [--apply]
import { db } from "../src/lib/db.ts";
import { appUrl, appBaseUrl } from "../src/lib/app-url.ts";
import { buildMagicLinkUrl } from "../src/lib/magic-link.ts";
import { queuePlatformDm } from "../src/lib/platform-jobs.ts";
import { channelFor } from "../src/lib/send-channel.ts";
import { cloudApiConfigFrom } from "../src/lib/cloud-api/client.ts";
import { askWindows } from "../src/lib/partner-ask-rules.ts";
import { loadPartnerAskSettings } from "../src/lib/club-partnership.ts";
import { PARTNER_ASK_CUTOFF_DEFAULT_HOURS } from "../src/lib/club-partnership-rules.ts";
import { DM_SUB_FIELDS, type DmSubField } from "../src/lib/dm-subscriptions.ts";
import { normaliseLang } from "../src/lib/i18n/lang.ts";
import { ledgerEntryOf } from "../src/lib/pool/candidate-rows.ts";
import { POOL_OFFER_PURPOSE } from "../src/lib/pool/dispatch.ts";
import { optedOutOfDms, planPoolAdmission, type PoolJobView } from "../src/lib/pool/dispatch-rules.ts";
import { isPoolOffersEnabled, poolOffersOpenForClub, poolSwitchEnv } from "../src/lib/pool/flags.ts";
import { poolPlatformOpenNow } from "../src/lib/pool/platform-switch.ts";
import { buildPoolManageLink } from "../src/lib/pool/links.ts";
import { OPEN_MATCH_STATUSES } from "../src/lib/pool/matching-rules.ts";
import { loadMatchOfferFacts } from "../src/lib/pool/offer-facts.ts";
import { poolOfferText } from "../src/lib/pool/offer-copy.ts";
import { poolOfferPath } from "../src/lib/pool/offer-token.ts";
import { offerExpiresAt } from "../src/lib/pool/waves.ts";
import { ignoredStreak } from "../src/lib/pool/caps.ts";
import { Prisma } from "../src/generated/prisma/client.ts";

const ASK_ID = "cmw8anveb001i07jpx27nkaoq";
const ORG_ID = "cmvzlm8km000707iihou1ut9h";
const MATCH_ID = "cmvzw1o9a000208l6pb9xe31n";
const EXPECTED_OFFERS = 4;
/** Room per Pi poll (platform-jobs.ts MAX_JOBS_PER_POLL); other due jobs in
 *  the same poll can only make it smaller (a HOLD, never a cancel). */
const POLL_LIMIT = 5;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const APPLY = process.argv.includes("--apply");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : "-");

async function main() {
  const now = new Date();
  console.log(`=== reopen vets pool offers: ${APPLY ? "APPLY" : "DRY RUN (writes nothing)"} at ${now.toISOString()} ===\n`);

  // The switches, resolved exactly as switch-env.ts resolvePoolEnv does
  // (no test override): the platform row, unless the env forces it off.
  const platformOpen = await poolPlatformOpenNow(process.env);
  const env = poolSwitchEnv(platformOpen === true, process.env);
  const ask = await db.poolAsk.findUnique({
    where: { id: ASK_ID },
    select: {
      id: true, matchId: true, orgId: true, places: true, status: true, closeReason: true, createdAt: true,
      org: { select: { name: true, featurePlayerPool: true } },
      match: { select: { date: true, status: true, isHistorical: true } },
    },
  });
  if (!ask) throw new Error(`ask ${ASK_ID} not found`);
  if (ask.orgId !== ORG_ID || ask.matchId !== MATCH_ID) throw new Error(`ask ${ASK_ID} is not the expected club/match`);
  const clubOpen = poolOffersOpenForClub(ask.org, env);
  const cutoffHours = (await loadPartnerAskSettings(ask.orgId))?.cutoffHours ?? PARTNER_ASK_CUTOFF_DEFAULT_HOURS;
  const cutoff = askWindows(ask.match.date, cutoffHours).postBy;
  const matchOpen =
    (OPEN_MATCH_STATUSES as readonly string[]).includes(ask.match.status) && !ask.match.isHistorical && ask.match.date.getTime() > now.getTime();

  console.log(`club:            ${ask.org.name} (${ask.orgId})`);
  console.log(`ask:             ${ask.id} status=${ask.status}${ask.closeReason ? ` closeReason=${ask.closeReason}` : ""} places=${ask.places} created=${iso(ask.createdAt)}`);
  console.log(`match:           ${ask.matchId} kickoff=${iso(ask.match.date)} status=${ask.match.status} historical=${ask.match.isHistorical}`);
  console.log(`cut-off:         ${iso(cutoff)} (${cutoffHours}h before kickoff); now is ${now.getTime() < cutoff.getTime() ? "BEFORE" : "PAST"} it`);
  console.log(`platform switch: ${platformOpen === null ? "UNREAD (db error)" : platformOpen ? "ON" : "OFF"}; isPoolOffersEnabled=${isPoolOffersEnabled(env)}`);
  console.log(`club flag:       featurePlayerPool=${ask.org.featurePlayerPool}`);
  console.log(`pool open for club (the one rule): ${clubOpen}`);

  const globalBlockers: string[] = [];
  if (!clubOpen) globalBlockers.push("the pool is not open for this club (platform switch or club flag off)");
  if (ask.status !== "open") globalBlockers.push(`the ask is not open (${ask.status})`);
  if (!matchOpen) globalBlockers.push(`the match is not open (${ask.match.status})`);
  if (now.getTime() >= cutoff.getTime()) globalBlockers.push("the club's cut-off has passed");
  if (globalBlockers.length) console.log(`\n!!! BLOCKED: ${globalBlockers.join("; ")}. --apply will refuse.`);

  const facts = await loadMatchOfferFacts(ask.matchId, now);
  if (!facts) throw new Error("no offer facts for the match (sport not offerable?)");

  const offers = await db.poolOffer.findMany({
    where: { poolAskId: ASK_ID },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, userId: true, distanceMiles: true, wave: true, platformJobId: true, sentAt: true, expiresAt: true,
      outcome: true, resolvedAt: true, repliedVia: true, createdAt: true,
    },
  });
  console.log(`\noffers on the ask: ${offers.length} (expected ${EXPECTED_OFFERS})`);
  if (offers.length !== EXPECTED_OFFERS) console.log(`!!! unexpected offer count`);

  const userIds = offers.map((o) => o.userId);
  const since26h = new Date(now.getTime() - 26 * HOUR_MS);
  const [profiles, memberships, ledgerRows, busyJobs, oldJobs] = await Promise.all([
    db.poolProfile.findMany({
      where: { userId: { in: userIds } },
      // The phone comes from the profile's user, exactly as sendWave reads it.
      select: { userId: true, status: true, pausedReason: true, pausedAt: true, consentAt: true, lastActiveAt: true, language: true, user: { select: { name: true, phoneNumber: true } } },
    }),
    db.membership.findMany({
      where: { userId: { in: userIds }, leftAt: null },
      select: { userId: true, subPrefsUpdatedAt: true, ...Object.fromEntries(DM_SUB_FIELDS.map((f) => [f, true])) } as { userId: true; subPrefsUpdatedAt: true } & Record<DmSubField, true>,
    }),
    db.poolOffer.findMany({
      where: { userId: { in: userIds }, createdAt: { gte: new Date(now.getTime() - 60 * DAY_MS) } },
      select: { id: true, userId: true, matchId: true, orgId: true, sentAt: true, createdAt: true, outcome: true, resolvedAt: true, platformJobId: true },
    }),
    db.platformJob.findMany({
      where: {
        purpose: POOL_OFFER_PURPOSE,
        OR: [{ status: "claimed", claimedAt: { gte: since26h } }, { status: { in: ["sent", "unconfirmed"] }, sentAt: { gte: since26h } }],
      },
      select: { id: true, status: true, claimedAt: true, sentAt: true },
    }),
    db.platformJob.findMany({
      where: { id: { in: offers.map((o) => o.platformJobId).filter((x): x is string => !!x) } },
      select: { id: true, status: true, sentAt: true, claimedAt: true, failReason: true, text: true, createdAt: true },
    }),
  ]);
  // The channel column is read raw: the generated Prisma client on this
  // checkout may predate it (see the --apply guard below).
  const channelRows = await db.$queryRaw<Array<{ id: string; channel: string }>>`
    SELECT id, channel FROM "PlatformJob" WHERE id = ANY(${oldJobs.map((j) => j.id)}::text[])`;
  const channelOf = new Map(channelRows.map((r) => [r.id, r.channel]));
  const profileOf = new Map(profiles.map((p) => [p.userId as string, p]));
  const userOf = (userId: string) => ({ name: profileOf.get(userId)?.user?.name ?? null, phoneNumber: profileOf.get(userId)?.user?.phoneNumber ?? null });
  const jobOf = new Map(oldJobs.map((j) => [j.id, { ...j, channel: channelOf.get(j.id) ?? "?" }]));
  const inFlightAt = new Map(busyJobs.filter((j) => j.status === "claimed" && j.claimedAt).map((j) => [j.id, j.claimedAt as Date]));
  const busy = busyJobs.map((j) => (j.status === "claimed" ? j.claimedAt : j.sentAt)).filter((d): d is Date => !!d && d.getTime() <= now.getTime());
  console.log(`platform pool DMs in flight/sent in the last 26h (what the platform caps count): ${busy.length}`);

  // The placeholder window, exactly as sendWave writes it at queue time;
  // onPoolOfferJobSent replaces it with the real one when the Pi says sent.
  const placeholderExpiresAt = offerExpiresAt(now, cutoff);
  const wouldChannel = channelFor({ purpose: POOL_OFFER_PURPOSE, officialNumberReady: cloudApiConfigFrom() !== null });
  console.log(`placeholder expiresAt for reopened offers: ${iso(placeholderExpiresAt)}`);
  console.log(`channel a new pool-offer job gets from this process: ${wouldChannel}`);
  const clientFresh = "channel" in Prisma.PlatformJobScalarFieldEnum;
  console.log(`generated Prisma client knows PlatformJob.channel: ${clientFresh ? "yes" : "NO (stale: run `npx prisma generate` before --apply, or --apply refuses)"}`);

  // What admitPoolOfferJobs would see once each offer is reopened (its own
  // row excluded from its ledger, exactly as dispatch.ts does: r.id !== o.id).
  type Plan = { offerId: string; skip: string | null };
  const plans: Plan[] = [];
  const views: PoolJobView[] = [];
  for (const o of offers) {
    const p = profileOf.get(o.userId);
    const optedOut = optedOutOfDms({ memberships: memberships.filter((m) => m.userId === o.userId), poolConsentAt: p?.consentAt ?? null });
    const reasons: string[] = [...globalBlockers];
    if (o.outcome !== "ignored") reasons.push(`outcome is ${o.outcome ?? "NULL (open)"}, not "ignored"`);
    if (!p || p.status !== "active") reasons.push(`profile is ${p?.status ?? "missing"}${p?.pausedReason ? ` (${p.pausedReason})` : ""}`);
    if (optedOut) reasons.push("opted out of MatchTime DMs");
    if (!userOf(o.userId).phoneNumber) reasons.push("no phone number");
    const old = o.platformJobId ? jobOf.get(o.platformJobId) : undefined;
    if (old && old.channel !== wouldChannel) reasons.push(`old job went on ${old.channel}, a new one would go on ${wouldChannel}`);
    plans.push({ offerId: o.id, skip: reasons.length ? reasons.join("; ") : null });
    views.push({
      jobId: `would-be-job:${o.id}`,
      offerId: o.id,
      userId: o.userId,
      orgId: ask.orgId,
      clubOpen,
      profileActive: p?.status === "active",
      dmOptedOut: optedOut,
      offerOpen: true,
      askOpen: ask.status === "open",
      gameOpen: matchOpen && now.getTime() < cutoff.getTime() && now.getTime() < placeholderExpiresAt.getTime(),
      ledger: ledgerRows
        .filter((r) => r.userId === o.userId && r.id !== o.id)
        .map((r) => ({ r, at: r.sentAt ?? (r.platformJobId ? inFlightAt.get(r.platformJobId) : undefined) ?? null }))
        .filter(({ r, at }) => at !== null || (r.outcome !== null && r.outcome !== "cancelled"))
        .map(({ r, at }) => ledgerEntryOf({ ...r, sentAt: at, jobSendAfter: null })),
    });
  }
  const admission = planPoolAdmission(views, busy, now, POLL_LIMIT);
  const verdictOf = (offerId: string): string => {
    const jobId = `would-be-job:${offerId}`;
    if (admission.admit.includes(jobId)) return "ADMIT";
    if (admission.hold.includes(jobId)) return "HOLD (no platform room this poll; stays queued, retried next poll)";
    const c = admission.cancel.find((x) => x.jobId === jobId);
    return c ? `CANCEL at dispatch: ${c.reason} (cap/state would hold him back; the offer would end "cancelled")` : "?";
  };

  const authOk: boolean[] = [];
  for (const o of offers) {
    const p = profileOf.get(o.userId);
    const old = o.platformJobId ? jobOf.get(o.platformJobId) : undefined;
    const lang = normaliseLang(p?.language);
    const plan = plans.find((x) => x.offerId === o.id)!;
    const others = ledgerRows.filter((r) => r.userId === o.userId && r.id !== o.id);
    const streakNow = ignoredStreak(ledgerRows.filter((r) => r.userId === o.userId).map((r) => ledgerEntryOf({ ...r, jobSendAfter: null })), p?.lastActiveAt ?? null);

    // The tap link is a pure HMAC of the offer id: if the old DM carries the
    // same path, this machine's AUTH_SECRET and base URL match production's.
    const tapLink = appUrl(poolOfferPath(o.id));
    const matchesOld = !!old?.text && old.text.includes(tapLink);
    authOk.push(matchesOld);
    // The manage link is a fresh short link (a ShortLink row): built only on
    // --apply, so the dry run shows its shape with a placeholder code.
    const manageLink = APPLY ? "" : buildMagicLinkUrl("<new-short-code>");
    const text = poolOfferText(lang, { ...facts, places: ask.places, distanceMiles: o.distanceMiles }, { tapLink, manageLink });

    console.log(`\n------------------------------------------------------------`);
    console.log(`${userOf(o.userId).name ?? "(no name)"}  userId=${o.userId}`);
    console.log(`  offer ${o.id}: wave=${o.wave} outcome=${o.outcome ?? "NULL"} sentAt=${iso(o.sentAt)} expiresAt=${iso(o.expiresAt)} resolvedAt=${iso(o.resolvedAt)} created=${iso(o.createdAt)} distance=${o.distanceMiles.toFixed(2)}mi`);
    console.log(`  profile: status=${p?.status ?? "MISSING"}${p?.pausedReason ? ` pausedReason=${p.pausedReason} pausedAt=${iso(p.pausedAt)}` : ""} consentAt=${iso(p?.consentAt)} lastActiveAt=${iso(p?.lastActiveAt)} language=${p?.language ?? "-"} -> ${lang}`);
    console.log(`  old job: ${o.platformJobId ?? "none"} status=${old?.status ?? "-"} channel=${old?.channel ?? "-"} created=${iso(old?.createdAt)} claimed=${iso(old?.claimedAt)} sent=${iso(old?.sentAt)}${old?.failReason ? ` failReason=${old.failReason}` : ""}`);
    console.log(`  old DM carries the same tap link (AUTH_SECRET + base URL match prod): ${matchesOld ? "YES" : "NO"}`);
    console.log(`  his other pool offers (60d): ${others.length ? others.map((r) => `${r.id} match=${r.matchId} sent=${iso(r.sentAt)} outcome=${r.outcome ?? "NULL"}`).join(" | ") : "none"}`);
    console.log(`  ignored streak since lastActiveAt (3 pauses him): ${streakNow}`);
    console.log(`  reopen: ${plan.skip ? `SKIP: ${plan.skip}` : "YES"}`);
    console.log(`  dispatch verdict (planPoolAdmission, his own old row excluded): ${verdictOf(o.id)}`);
    console.log(`  message (${lang}, ${userOf(o.userId).phoneNumber ?? "no phone"}):`);
    console.log(text.split("\n").map((l) => `    | ${l}`).join("\n"));
  }

  console.log(`\n------------------------------------------------------------`);
  console.log(`admission plan: admit=${admission.admit.length} hold=${admission.hold.length} cancel=${admission.cancel.length}`);
  if (!authOk.every(Boolean)) console.log(`!!! at least one old DM does not carry the recomputed tap link: AUTH_SECRET or base URL (${appBaseUrl()}) may differ from prod. --apply will refuse.`);

  if (!APPLY) {
    console.log(`\nDRY RUN: nothing written. Re-run with --apply to reopen ${plans.filter((p) => !p.skip).length} offer(s).`);
    return;
  }
  if (globalBlockers.length) {
    console.log(`\nREFUSED: ${globalBlockers.join("; ")}`);
    process.exitCode = 1;
    return;
  }
  if (!("channel" in Prisma.PlatformJobScalarFieldEnum)) {
    console.log(`\nREFUSED: the generated Prisma client predates PlatformJob.channel, so queuePlatformDm would fail. Run \`npx prisma generate\` first.`);
    process.exitCode = 1;
    return;
  }
  if (!authOk.every(Boolean)) {
    console.log(`\nREFUSED: tap links would not match production's signing.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== APPLY ===`);
  for (const o of offers) {
    const plan = plans.find((x) => x.offerId === o.id)!;
    if (plan.skip) {
      console.log(`${o.id} (${userOf(o.userId).name}): skipped: ${plan.skip}`);
      continue;
    }
    const p = profileOf.get(o.userId)!;
    const lang = normaliseLang(p.language);
    // Built before the transaction, as sendWave does (it writes a ShortLink).
    const manageLink = await buildPoolManageLink(o.userId);
    const at = new Date();
    try {
      const result = await db.$transaction(
        async (tx) => {
          // The same lock sendWave holds: no wave runs on this ask meanwhile.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pool-ask:${ASK_ID}`}))`;
          const fresh = await tx.poolAsk.findUnique({ where: { id: ASK_ID }, select: { status: true } });
          if (fresh?.status !== "open") return `ask is ${fresh?.status ?? "gone"} now`;
          const prof = await tx.poolProfile.findUnique({ where: { userId: o.userId }, select: { status: true } });
          if (prof?.status !== "active") return `profile is ${prof?.status ?? "missing"} now`;
          const reset = await tx.poolOffer.updateMany({
            where: { id: o.id, outcome: "ignored" },
            data: { outcome: null, resolvedAt: null, sentAt: null, repliedVia: null, expiresAt: offerExpiresAt(at, cutoff), createdAt: at },
          });
          if (reset.count !== 1) return "offer is no longer \"ignored\" (already reopened or answered): nothing queued";
          const text = poolOfferText(lang, { ...facts, places: ask.places, distanceMiles: o.distanceMiles }, {
            tapLink: appUrl(poolOfferPath(o.id)),
            manageLink,
          });
          const job = await queuePlatformDm({
            phone: userOf(o.userId).phoneNumber as string,
            text,
            purpose: POOL_OFFER_PURPOSE,
            refId: o.id,
            sendAfter: null,
            client: tx as unknown as Parameters<typeof queuePlatformDm>[0]["client"],
          });
          await tx.poolOffer.update({ where: { id: o.id }, data: { platformJobId: job.id } });
          return `reopened; job ${job.id} queued on ${job.channel}`;
        },
        { maxWait: 20_000, timeout: 30_000 },
      );
      console.log(`${o.id} (${userOf(o.userId).name}): ${result}`);
    } catch (err) {
      console.error(`${o.id} (${userOf(o.userId).name}): FAILED, rolled back:`, err instanceof Error ? err.message : err);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
