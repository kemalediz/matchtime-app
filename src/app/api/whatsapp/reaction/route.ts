/**
 * Reactions on the bot's bench-slot-offer post.
 *
 * Bench redesign 2026-05-19 (Kemal): the offer is broadcast to the
 * WHOLE bench, so a 👍 from ANY current bench player claims the slot
 * (first one wins, atomically — see resolveBenchConfirmation). 👎 is
 * a no-op: nobody is ever removed for passing or staying silent.
 *
 * Reactor resolution is scoped to the bench of the offer's match:
 * phone first, then @lid pushname matched UNIQUELY against that small
 * bench set. We can't promote a non-bencher.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { normalisePhone } from "@/lib/phone";
import { resolveBenchConfirmation } from "@/lib/bench-confirmation";

const norm = (s: string) =>
  s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export async function POST(request: Request) {
  const apiKey = request.headers.get("x-api-key");
  if (apiKey !== process.env.WHATSAPP_API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { waMessageId, emoji, fromPhone, fromAuthorName } = body as {
    waMessageId: string;
    emoji: string;
    fromPhone: string;
    fromAuthorName?: string | null;
  };
  if (!waMessageId || !emoji) {
    return NextResponse.json({ error: "waMessageId, emoji required" }, { status: 400 });
  }

  // The offer post the reaction is on (set on /ack via the offer- key).
  const offer = await db.benchSlotOffer.findFirst({
    where: { waMessageId, resolvedAt: null },
    include: {
      match: {
        include: {
          activity: { select: { orgId: true } },
          attendances: {
            where: { status: "BENCH" },
            include: { user: { select: { id: true, name: true, phoneNumber: true } } },
          },
        },
      },
    },
  });
  if (!offer) return NextResponse.json({ ok: true, ignored: "no-open-offer" });

  const isYes =
    emoji === "👍" || emoji === "👍🏻" || emoji === "👍🏼" || emoji === "👍🏽" ||
    emoji === "👍🏾" || emoji === "👍🏿" || emoji === "✅" || emoji === "🙋" ||
    emoji === "🙋‍♂️" || emoji === "🙋‍♀️";
  const isNo =
    emoji === "👎" || emoji === "👎🏻" || emoji === "👎🏼" || emoji === "👎🏽" ||
    emoji === "👎🏾" || emoji === "👎🏿";
  if (!isYes && !isNo) {
    return NextResponse.json({ ok: true, ignored: "not-yes-no" });
  }
  if (isNo) {
    // Passing is a no-op — they stay on the bench. Nothing to do.
    return NextResponse.json({ ok: true, outcome: "declined" });
  }

  // Resolve the reactor to one of THIS match's bench players.
  const bench = offer.match.attendances;
  let claimantId: string | null = null;

  const normalised = fromPhone ? normalisePhone(fromPhone) : null;
  if (normalised) {
    const m = bench.find(
      (a) => a.user.phoneNumber && normalisePhone(a.user.phoneNumber) === normalised,
    );
    if (m) claimantId = m.user.id;
  }
  if (!claimantId && fromAuthorName && fromAuthorName.trim().length >= 2) {
    const key = norm(fromAuthorName);
    const orgId = offer.match.activity.orgId;
    // Exact name among the bench.
    const exact = bench.filter((a) => a.user.name && norm(a.user.name) === key);
    if (exact.length === 1) claimantId = exact[0].user.id;
    // Admin alias → must point at a bench member.
    if (!claimantId) {
      const alias = await db.userAlias.findUnique({
        where: { orgId_alias: { orgId, alias: key } },
        select: { userId: true },
      });
      if (alias && bench.some((a) => a.user.id === alias.userId)) {
        claimantId = alias.userId;
      }
    }
    // Unique first-name fuzzy within the bench set only.
    if (!claimantId) {
      const pf = key.split(/\s+/).filter(Boolean)[0] ?? "";
      const fz = bench.filter((a) => {
        if (!a.user.name) return false;
        const df = norm(a.user.name).split(/\s+/).filter(Boolean)[0] ?? "";
        return (
          df === pf ||
          (df.length >= 3 && pf.length >= 2 && df.startsWith(pf)) ||
          (pf.length >= 3 && df.length >= 2 && pf.startsWith(df))
        );
      });
      if (fz.length === 1) claimantId = fz[0].user.id;
    }
  }

  if (!claimantId) {
    return NextResponse.json({ ok: true, ignored: "reactor-not-on-bench" });
  }

  const res = await resolveBenchConfirmation({
    matchId: offer.matchId,
    userId: claimantId,
    decision: true,
  });
  return NextResponse.json({ ok: true, outcome: res.kind });
}
