/**
 * A SEASON BREAK BY DM (2026-10-29): an organiser of a monthly club DMs
 * MatchTime "no football in December" or "aralıkta maç yok". His DM is read
 * by the same admin extractor the groups use (the shared pipeline's model,
 * `extractForRoute("admin_ops")`), and only a `season_break` reading acts;
 * anything else goes on to the other DM handlers.
 *
 * Only for an OWNER or ADMIN of exactly one club on monthly mode (with two,
 * which club is the page's question). One Haiku call per such DM, none for
 * anybody else.
 */
import { db } from "./db";
import { ORDINARY_MEMBER_WHERE } from "./guest-membership";
import { extractForRoute } from "./pipeline/extractors";
import { extractorStubFromEnv } from "./pipeline/extractor-stub";
import { anthropicModel, type PipelineModel } from "./pipeline/llm";
import { normaliseSquadMode } from "./squad-month-rules";

export interface SeasonBreakDmHandled {
  handled: "season-break-set" | "season-break-unchanged" | "season-break-refused";
}

export async function handleSeasonBreakDm(input: {
  userId: string;
  text: string;
  authorName: string | null;
  replyPhone: string | null;
  now: Date;
  deps?: { model?: PipelineModel | null };
}): Promise<SeasonBreakDmHandled | null> {
  try {
    const clubs = await db.membership.findMany({
      where: { userId: input.userId, leftAt: null, role: { in: ["OWNER", "ADMIN"] }, ...ORDINARY_MEMBER_WHERE },
      select: { org: { select: { id: true, squadMode: true, language: true } } },
    });
    const monthly = clubs.filter((c) => normaliseSquadMode(c.org.squadMode) === "monthly");
    if (monthly.length !== 1 || !input.text.trim()) return null;
    const org = monthly[0].org;
    const model = input.deps?.model === undefined ? (extractorStubFromEnv() ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null)) : input.deps.model;
    if (!model) return null;
    const { withOrgAiBudget } = await import("./ai-budget");
    const ex = await withOrgAiBudget(org.id, () =>
      extractForRoute(model, "admin_ops", { id: "dm", body: input.text, authorName: input.authorName, tagged: true, history: [], lastBotPost: null, now: input.now }),
    );
    if (ex.facts.kind !== "admin" || ex.facts.action !== "season_break") return null;
    const { applySeasonBreakWords } = await import("./season-break-words");
    const r = await applySeasonBreakWords({ orgId: org.id, breakMonths: ex.facts.breakMonths ?? [], playMonths: ex.facts.playMonths ?? [], lang: org.language, now: input.now });
    if (input.replyPhone) await db.botJob.create({ data: { orgId: org.id, kind: "dm", phone: input.replyPhone, text: r.replyText } });
    console.info(`[season-break-dm] user=${input.userId} org=${org.id} ${r.outcome}`);
    return { handled: r.outcome };
  } catch (err) {
    console.error("[season-break-dm] failed:", err instanceof Error ? err.message : "failed");
    return null;
  }
}
