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
 * Its only side effects are one `WindowVerdict` row and a
 * `console.error` per alert. It proposes no write and sends no message:
 * acting on a day-old attendance claim would be worse than missing it,
 * because the squad has moved on.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { isNoneBucketShadowEnabled } from "@/lib/pipeline/gate";
import {
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

    // Persist to the table the shadow harness and /admin/shadow already
    // use, so this shows up on the dashboard that exists. Best-effort:
    // the sweep's value is the log line and the alert, and failing to
    // file the row must not lose them. `orgId` is the org the alerts
    // came from, or skipped entirely when there is nothing to file.
    const orgId = result.alerts[0]?.orgId ?? null;
    if (orgId && result.checked > 0) {
      try {
        await db.windowVerdict.create({
          data: {
            orgId,
            windowStart: new Date(Date.now() - 24 * 3_600_000),
            windowEnd: new Date(),
            batchHash: `none-bucket:${new Date().toISOString().slice(0, 10)}`,
            modelMs: result.ms,
            costUsd: result.costUsd,
            // Prisma's `InputJsonValue` will not accept a plain
            // `Record<string, unknown>`; the payload is JSON by
            // construction (`toWindowShape` builds it from primitives),
            // so a round-trip is the honest way to say so.
            verdictJson: JSON.parse(JSON.stringify(toWindowShape(result))),
            currentVerdictRefs: result.alerts.map((a) => a.waMessageId),
          },
        });
      } catch (err) {
        // A unique violation is the day's sweep already being filed —
        // expected on a re-run, and not worth a 500.
        const m = err instanceof Error ? err.message : String(err);
        if (!/unique/i.test(m)) console.error("[none-shadow] failed to file WindowVerdict:", err);
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
    });
  } catch (err) {
    console.error("[none-shadow] sweep failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
