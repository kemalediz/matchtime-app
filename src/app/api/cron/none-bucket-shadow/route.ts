/**
 * §11.1's fourth containment, on a timer.
 *
 *   "Sample `none`-routed messages through the full extractor nightly,
 *    offline, and alert on any that produce a claim. This is the
 *    regression detector the current architecture has never had."
 *
 * Runs at 03:00 UTC (`vercel.json`), well clear of any match. OFF unless
 * `NONE_BUCKET_SHADOW_ENABLED` is set — with the gate off there is
 * nothing tagged `router-gate` to look at anyway, but a nightly job that
 * spends money should be one somebody turned on.
 *
 * Its only side effects are one `WindowVerdict` row per org and a
 * `console.error` per alert. It proposes no write and sends no message:
 * acting on a day-old attendance claim would be worse than missing it,
 * because the squad has moved on.
 *
 * ── THE ROW IS THE HEARTBEAT (2026-09-11) ────────────────────────────
 *
 * This route used to file a row only when it had an alert to report. In
 * five nights it filed one, and a clean night looked exactly like a cron
 * that never fired (§1.4 of `MDs/router-accuracy-2026-09-11.md`: 1 of
 * 506 `WindowVerdict` rows, ever). It now files unconditionally, for
 * every org it is responsible for, saying which window it covered and
 * how many messages it examined — and `lib/bot-health.ts` raises
 * `none-shadow-stale` when no row turns up inside 30 hours. A monitor
 * nobody monitors is the failure this sweep exists to prevent, one
 * level up.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isNoneBucketShadowEnabled } from "@/lib/pipeline/gate";
import {
  noneShadowBatchHash,
  runNoneBucketShadow,
  toWindowShape,
  type NoneBucketDb,
} from "@/lib/pipeline/none-shadow";

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  // `?force=1` runs the sweep once with the flag still off, so an
  // operator can see what it WOULD say before turning it on. It cannot
  // write anything either way.
  const force = url.searchParams.get("force") === "1";
  if (!force && !isNoneBucketShadowEnabled()) {
    return NextResponse.json({
      ok: true,
      enabled: false,
      note:
        "none-bucket shadow is DISABLED (default). Set NONE_BUCKET_SHADOW_ENABLED=1, " +
        "or call with ?force=1 for a one-off run.",
    });
  }

  const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
  const lookbackHours = Number(url.searchParams.get("hours") ?? "") || undefined;

  try {
    const result = await runNoneBucketShadow({
      db: db as unknown as NoneBucketDb,
      force,
      ...(limit ? { limit } : {}),
      ...(lookbackHours ? { lookbackHours } : {}),
    });

    // ── FILE THE ROW, ALWAYS ──────────────────────────────────────────
    //
    // This block used to be `if (orgId && result.checked > 0)`, with
    // `orgId` taken from `result.alerts[0]?.orgId` — so a night on which
    // the sweep ran and correctly found nothing wrote NOTHING, and was
    // indistinguishable in the data from a cron that never fired, a
    // revoked API key, or a flag somebody turned off. It filed one row
    // in its whole life (§1.4). The org was always knowable from the
    // rows the sweep READ; only the alert was optional.
    //
    // One row per org per day, for every org the sweep is responsible
    // for — which is every org with the bot enabled, not just the ones
    // that happened to produce gated traffic. That is what makes a
    // ZERO-traffic night still leave evidence, and it is the set
    // `bot-health` iterates, so the two agree about whose absence counts.
    const batchHash = noneShadowBatchHash(result.windowEnd);
    const orgIds = new Set(result.byOrg.map((o) => o.orgId));
    for (const o of await db.organisation.findMany({
      where: { whatsappBotEnabled: true, whatsappGroupId: { not: null } },
      select: { id: true },
    })) {
      orgIds.add(o.id);
    }

    let filed = 0;
    for (const orgId of orgIds) {
      // Prisma's `InputJsonValue` will not accept a plain
      // `Record<string, unknown>`; the payload is JSON by construction
      // (`toWindowShape` builds it from primitives), so a round-trip is
      // the honest way to say so.
      const verdictJson = JSON.parse(JSON.stringify(toWindowShape(result, orgId)));
      const refs = result.alerts.filter((a) => a.orgId === orgId).map((a) => a.waMessageId);
      try {
        // UPSERT, not create-and-swallow. A same-day re-run (an operator
        // with `?force=1`, or a cron Vercel retried) must refresh the
        // day's row rather than be silently dropped — `windowEnd` is what
        // `bot-health` reads as "when did the sweep last file", so a
        // second run leaving the first run's timestamp would make a
        // working sweep look stale.
        await db.windowVerdict.upsert({
          where: { orgId_batchHash: { orgId, batchHash } },
          create: {
            orgId,
            windowStart: result.windowStart,
            windowEnd: result.windowEnd,
            batchHash,
            modelMs: result.ms,
            costUsd: result.costUsd,
            verdictJson,
            currentVerdictRefs: refs,
          },
          update: {
            windowStart: result.windowStart,
            windowEnd: result.windowEnd,
            modelMs: result.ms,
            costUsd: result.costUsd,
            verdictJson,
            currentVerdictRefs: refs,
          },
        });
        filed++;
      } catch (err) {
        // Best-effort per org: one org's bad row must not lose the
        // others, nor the log line and the alerts above. But it is now a
        // CRITICAL rather than a shrug — the row is the sweep's
        // heartbeat, and a heartbeat that fails to land reads downstream
        // as a sweep that never ran.
        console.error(`[none-shadow] failed to file WindowVerdict for ${orgId}:`, err);
      }
    }

    return NextResponse.json({
      ok: true,
      enabled: result.enabled,
      checked: result.checked,
      available: result.available,
      alerts: result.alerts.length,
      costUsd: result.costUsd,
      ms: result.ms,
      errors: result.errors.length,
      filed,
      batchHash,
    });
  } catch (err) {
    console.error("[none-shadow] sweep failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
