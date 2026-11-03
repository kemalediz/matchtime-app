/**
 * THE ORGANISER'S DM ANSWER TO A COMING-MONTH DRAFT (2026-10-29).
 *
 * An organiser posted the coming month's list in the players' group and
 * MatchTime DMed him the draft (`month-seed-group.ts`). His DM reply is read
 * by a model, with the draft as context (Kemal: never by phrases):
 *   - "yes" in any words: the month is started from the draft, exactly as
 *     the admin group's YES does (`applyMonthSeedYes`);
 *   - "no": nothing is started, and he is told;
 *   - a correction ("Craig is 4 only, Ben is PAYG", "add Steve", "take Jon
 *     off"): the draft is changed and sent again, still waiting for YES;
 *   - anything else: not an answer, and the DM goes on to the other
 *     handlers.
 *
 * One Haiku call per DM, and only while such a draft is open for him (one
 * indexed query for everybody else). Fail safe: a failed or unsure read is
 * "other", which changes nothing.
 */
import { db } from "./db";
import { t } from "./i18n/t";
import { monthNameLabel } from "./i18n/dates";
import { dmClassifierStubCall } from "./dm-classifier-stub";
import { anthropicModel, extractJson, HAIKU_CALL, type ModelCall, type PipelineModel } from "./pipeline/llm";
import type { MonthSeedProposalData } from "./month-seed-hq";
import type { SeedRowInput } from "./squad-month-rules";

export const MONTH_SEED_REPLY_CALL: ModelCall = HAIKU_CALL;
const LABEL = "month-seed-reply";
const HEADER = "HIS REPLY:";
/** A draft offered by DM waits this long for his answer. */
export const MONTH_SEED_DM_TTL_MS = 24 * 3600 * 1000;
/** The SentNotification kind that marks a proposal as offered by DM. */
export const MONTH_SEED_DM_KIND = "month-seed-dm";

export interface DraftLine {
  ref: string;
  name: string;
  kind: "regular" | "payg";
  games: number | null;
}

export type SeedReplyChange =
  | { action: "add" | "remove" | "regular" | "payg"; userId: string }
  | { action: "games"; userId: string; games: number | null }
  /** A name on his list that matched nobody (`listed`, its u ref) is this member. */
  | { action: "match"; userId: string; listed: string };

export type SeedReply = { kind: "yes" } | { kind: "no" } | { kind: "change"; changes: SeedReplyChange[] } | { kind: "other"; why: string };

export const MONTH_SEED_REPLY_SYSTEM = `An organiser of a football club posted the month's list in the players' WhatsApp group. MatchTime, the club's bot, read it into a DRAFT of who is on the month and sent it to him privately. Read his reply.

You get, in this order:
- THE DRAFT: who is on it, each with a ref (p1, p2 ...), how they pay, and any "games only".
- MEMBERS: the club's members MatchTime knows by name, with refs and any nicknames.
- NAMES NOT MATCHED: names on his list MatchTime could not match to anybody, refs u1, u2 ... (when there are any).
- NO NAME YET: members MatchTime has no name for, numbered as in its message to him: n3 is number 3 (when there are any).
- The exact message MatchTime sent him, then his reply under "${HEADER}".

"answer" is one of:
- "yes": start the month with the draft as it is, in any words ("yes", "go ahead", "looks good", "evet", "başlat", a thumbs up).
- "no": do not start it ("no", "not yet", "hold off", "hayır", "bekle").
- "change": he corrects the draft or says who is who. Each change goes in "changes", with "member" the ref of the member he means (a p or n ref):
  "add" puts a member on, "remove" takes one off; "regular" or "payg" is how they pay; "games" is the games of the month they commit to, in "games" (0 for every game); "match" says a name not matched is this member, with that name's u ref in "listed" ("Craig is 3": listed Craig's u ref, member n3).
  "games" is 0 and "listed" is "" where they do not apply. A correction with a yes in it ("yes but Ben is PAYG") is "change".
- "other": anything else, a question, or somebody or a number you cannot find above.

Examples (English | Turkish):
- "yes" | "evet, başlat": yes.
- "no, wait till Friday" | "hayır, bekle": no.
- "Craig is 4 only, Ben is PAYG" | "Craig sadece 4 hafta, Ben maç başı": change [games Craig 4, payg Ben].
- "add Steve and take Jon off" | "Steve'i ekle, Jon'u çıkar": change [add Steve, remove Jon].
- "Craig is 3, steff is the 7 one" | "Craig 3 numara, steff 7": change [match Craig n3, match steff n7].
- "who's on it?" | "kimler var?": other.

If you are not at least 80% sure, choose "other": a wrong yes starts a month nobody agreed to, while "other" changes nothing.

Output STRICT JSON only, no markdown, no fences.`;

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", enum: ["yes", "no", "change", "other"] },
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "remove", "regular", "payg", "games", "match"] },
          member: { type: "string" },
          games: { type: "integer" },
          listed: { type: "string" },
        },
        required: ["action", "member", "games", "listed"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number" },
  },
  required: ["answer", "changes", "confidence"],
  additionalProperties: false,
} as const;

export function buildSeedReplyUserTurn(p: {
  draft: DraftLine[];
  members: Array<{ ref: string; name: string; aliases?: string[] }>;
  /** Names on his list that matched nobody, by u ref. */
  unmatched?: Array<{ ref: string; name: string }>;
  /** Members with no name, by n ref, as numbered in the message he got. */
  nameless?: Array<{ ref: string; n: number }>;
  asked: string;
  text: string;
}): string {
  const unmatched = p.unmatched ?? [];
  const nameless = p.nameless ?? [];
  return [
    "THE DRAFT:",
    ...p.draft.map((d) => `  ${d.ref}: ${d.name}, ${d.kind === "payg" ? "PAYG" : "regular"}${d.games ? `, ${d.games} games only` : ""}`),
    "MEMBERS:",
    ...p.members.map((m) => `  ${m.ref}: ${m.name}${m.aliases && m.aliases.length > 0 ? ` (also: ${m.aliases.join(", ")})` : ""}`),
    ...(unmatched.length > 0 ? ["NAMES NOT MATCHED:", ...unmatched.map((u) => `  ${u.ref}: ${u.name}`)] : []),
    ...(nameless.length > 0 ? ["NO NAME YET:", ...nameless.map((m) => `  ${m.ref}: number ${m.n} in the message`)] : []),
    `MATCHTIME ASKED HIM:\n${p.asked}`,
    `${HEADER}\n${p.text.trim()}`,
  ].join("\n");
}

/** PURE. The JSON, checked: refs map to members (named, or nameless by
 *  number), a match names a listed u ref, unsure is "other". */
export function parseSeedReply(raw: string, members: Array<{ ref: string; userId: string }>, listed: readonly string[] = []): SeedReply {
  let o: Record<string, unknown>;
  try {
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") return { kind: "other", why: "not an object" };
    o = parsed as Record<string, unknown>;
  } catch {
    return { kind: "other", why: "parse failed" };
  }
  if (typeof o.confidence !== "number" || o.confidence < 0.8) return { kind: "other", why: "low confidence" };
  if (o.answer === "yes") return { kind: "yes" };
  if (o.answer === "no") return { kind: "no" };
  if (o.answer !== "change") return { kind: "other", why: "other" };
  const byRef = new Map(members.map((m) => [m.ref, m.userId]));
  const changes: SeedReplyChange[] = [];
  for (const c of Array.isArray(o.changes) ? o.changes : []) {
    const x = c as Record<string, unknown>;
    const userId = typeof x.member === "string" ? byRef.get(x.member.trim()) : undefined;
    if (!userId) return { kind: "other", why: "a change names nobody" };
    if (x.action === "games") {
      const g = typeof x.games === "number" && Number.isInteger(x.games) && x.games >= 0 && x.games <= 31 ? x.games : null;
      changes.push({ action: "games", userId, games: g === 0 ? null : g });
    } else if (x.action === "match") {
      const ref = typeof x.listed === "string" ? x.listed.trim() : "";
      if (!listed.includes(ref)) return { kind: "other", why: "a match names no listed name" };
      changes.push({ action: "match", userId, listed: ref });
    } else if (x.action === "add" || x.action === "remove" || x.action === "regular" || x.action === "payg") {
      changes.push({ action: x.action, userId });
    }
  }
  return changes.length > 0 ? { kind: "change", changes } : { kind: "other", why: "no change" };
}

/** PURE. The draft with his changes. */
export function applySeedChanges(rows: SeedRowInput[], changes: SeedReplyChange[], nameOf: (userId: string) => string): SeedRowInput[] {
  let out = rows.map((r) => ({ ...r }));
  for (const c of changes) {
    // A match is applied to the draft's unknown names (`applyListMatch`).
    if (c.action === "match") continue;
    const i = out.findIndex((r) => r.userId === c.userId);
    if (c.action === "remove") out = out.filter((r) => r.userId !== c.userId);
    else if (c.action === "add") {
      if (i === -1) out.push({ userId: c.userId, kind: "regular", tier: "standard", slot: null, paid: "none", paidAmountPence: null, gamesCommitted: null, listName: nameOf(c.userId) });
    } else if (i !== -1) {
      if (c.action === "regular" || c.action === "payg") out[i] = { ...out[i], kind: c.action, ...(c.action === "payg" ? { gamesCommitted: null } : {}) };
      else if (c.action === "games") out[i] = { ...out[i], kind: "regular", gamesCommitted: c.games };
    } else if (c.action === "regular" || c.action === "payg") {
      out.push({ userId: c.userId, kind: c.action, tier: "standard", slot: null, paid: "none", paidAmountPence: null, gamesCommitted: null, listName: nameOf(c.userId) });
    } else if (c.action === "games") {
      out.push({ userId: c.userId, kind: "regular", tier: "standard", slot: null, paid: "none", paidAmountPence: null, gamesCommitted: c.games, listName: nameOf(c.userId) });
    }
  }
  return out;
}

export const MONTH_SEED_REPLY_STUB_FILE_ENV = "MT_TEST_MONTH_SEED_REPLY_STUB_FILE";

function stubModel(env: NodeJS.ProcessEnv): PipelineModel | null {
  // The stub's label is the model's raw answer, as JSON text.
  const call = dmClassifierStubCall(env[MONTH_SEED_REPLY_STUB_FILE_ENV], {
    label: LABEL,
    header: HEADER,
    answer: (label) => label ?? JSON.stringify({ answer: "other", changes: [], confidence: 1 }),
  });
  if (!call) return null;
  return {
    name: "month-seed-reply-stub",
    complete: async (req) => ({ text: await call(req.system, req.user), stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0, ms: 0 }),
  };
}

/** Read his reply, once. Never throws. */
export async function readSeedReply(
  p: {
    draft: DraftLine[];
    members: Array<{ ref: string; userId: string; name: string; aliases?: string[] }>;
    unmatched?: Array<{ ref: string; name: string }>;
    nameless?: Array<{ ref: string; n: number; userId: string }>;
    asked: string;
    text: string;
  },
  deps?: { model?: PipelineModel | null },
): Promise<SeedReply> {
  if (!p.text?.trim()) return { kind: "other", why: "empty" };
  const model = deps?.model === undefined ? (stubModel(process.env) ?? (process.env.ANTHROPIC_API_KEY?.trim() ? anthropicModel() : null)) : deps.model;
  if (!model) return { kind: "other", why: "reader unavailable" };
  try {
    const resp = await model.complete({
      ...MONTH_SEED_REPLY_CALL,
      system: MONTH_SEED_REPLY_SYSTEM,
      user: buildSeedReplyUserTurn(p),
      maxTokens: 2_048,
      schema: SCHEMA as unknown as Record<string, unknown>,
      // Asked a few times a month: a 1-hour cache write would cost more than it saves.
      cache: false,
      label: LABEL,
    });
    return parseSeedReply(
      resp.text,
      [...p.members, ...(p.nameless ?? []).map((m) => ({ ref: m.ref, userId: m.userId }))],
      (p.unmatched ?? []).map((u) => u.ref),
    );
  } catch (err) {
    console.error(`[${LABEL}] read failed:`, err instanceof Error ? err.message : "failed");
    return { kind: "other", why: "reader error" };
  }
}

// ── The DM door ───────────────────────────────────────────────────────

export interface SeedDmHandled {
  handled: "month-seed-started" | "month-seed-declined" | "month-seed-changed" | "month-seed-failed";
  monthStart: string;
}

export async function handleMonthSeedDmReply(input: {
  userId: string;
  text: string;
  replyPhone: string | null;
  /** The DM's WhatsApp id: one delivery is answered once. */
  waMessageId: string;
  /** Which of MatchTime's messages he answers (`dm-answering.ts`). */
  answering: () => Promise<string | null>;
  now: Date;
  deps?: { model?: PipelineModel | null };
}): Promise<SeedDmHandled | null> {
  try {
    return await reply(input);
  } catch (err) {
    console.error(`[${LABEL}] reply failed:`, err instanceof Error ? err.message : "failed");
    return null;
  }
}

async function reply(input: Parameters<typeof handleMonthSeedDmReply>[0]): Promise<SeedDmHandled | null> {
  const { userId, now } = input;
  const proposal = await db.adminSquadProposal.findFirst({
    where: { proposedByUserId: userId, resolvedAt: null, expiresAt: { gt: now }, monthStart: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { id: true, orgId: true, waMessageId: true, monthStart: true, monthSeed: true },
  });
  if (!proposal?.monthStart || !proposal.monthSeed) return null;
  const offered = await db.sentNotification.findFirst({
    where: { kind: MONTH_SEED_DM_KIND, key: `org-${proposal.orgId}:month-seed-dm:${proposal.id}` },
    select: { text: true },
  });
  if (!offered) return null;
  // Only an answer to THIS draft (the message he replies to, or MatchTime's
  // newest DM to him, is it): review of #465.
  const answering = (await input.answering())?.trim() ?? "";
  if (!offered.text || answering !== offered.text.trim()) return null;
  const org = await db.organisation.findUnique({ where: { id: proposal.orgId }, select: { language: true, adminGroupId: true } });
  const lang = org?.language ?? null;
  const data = proposal.monthSeed as unknown as MonthSeedProposalData;
  const memberships = await db.membership.findMany({
    where: { orgId: proposal.orgId, leftAt: null, guestMatchId: null, user: { isActive: true } },
    select: { role: true, user: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  // Still an organiser, or his word starts nothing.
  if (!memberships.some((m) => m.user.id === userId && (m.role === "OWNER" || m.role === "ADMIN"))) return null;
  const aliases = await db.userAlias.findMany({ where: { orgId: proposal.orgId }, select: { userId: true, alias: true } });
  const members = memberships
    .filter((m) => m.user.name)
    .map((m, i) => ({ ref: `p${i + 1}`, userId: m.user.id, name: m.user.name as string, aliases: aliases.filter((a) => a.userId === m.user.id).map((a) => a.alias) }));
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.name ?? "";
  const refOf = (id: string) => members.find((m) => m.userId === id)?.ref ?? "?";
  const draft: DraftLine[] = data.rows.map((r) => ({ ref: refOf(r.userId), name: r.listName || nameOf(r.userId), kind: r.kind === "payg" ? "payg" : "regular", games: r.gamesCommitted ?? null }));
  // The names nobody matched, and the nameless members as the DM he is
  // answering numbered them (2026-11-03, `month-seed-match.ts`). A member
  // who has left since is not offered.
  const current = new Set(memberships.map((m) => m.user.id));
  const unmatched = (data.unmatched ?? []).map((u) => ({ ref: u.ref, name: u.name }));
  const nameless = (data.nameless ?? []).filter((m) => current.has(m.userId)).map((m) => ({ ref: `n${m.n}`, n: m.n, userId: m.userId }));

  // One delivery of a DM is read and answered once (a Pi retry is not),
  // claimed before the model is asked.
  try {
    await db.sentNotification.create({ data: { key: `org-${proposal.orgId}:month-seed-dm-reply:${input.waMessageId}`, kind: "month-seed-dm-reply" } });
  } catch {
    return null;
  }
  const { withOrgAiBudget } = await import("./ai-budget");
  const answer = await withOrgAiBudget(proposal.orgId, () =>
    readSeedReply({ draft, members, unmatched, nameless, asked: offered.text ?? "", text: input.text }, input.deps),
  );
  console.info(`[${LABEL}] user=${userId} proposal=${proposal.id} answer=${answer.kind}${answer.kind === "other" ? ` why=${answer.why}` : ""}`);
  if (answer.kind === "other") return null;

  const send = async (text: string) => {
    if (input.replyPhone) await db.botJob.create({ data: { orgId: proposal.orgId, kind: "dm", phone: input.replyPhone, text } });
  };
  const month = monthNameLabel(lang, new Date(`${proposal.monthStart}T12:00:00.000Z`));

  if (answer.kind === "change") {
    // "Craig is 3": the name leaves the unknown list and the member joins
    // the draft with Craig's line (`applyListMatch`). A member already on
    // the draft cannot be a second line, and is left as he is.
    const { applyListMatch } = await import("./month-seed-match-rules");
    let next: MonthSeedProposalData = data;
    const matched: Array<{ userId: string; name: string }> = [];
    for (const c of answer.changes) {
      if (c.action !== "match") continue;
      const r = applyListMatch(next, c.listed, c.userId);
      if (r.ok) {
        next = r.data;
        matched.push({ userId: c.userId, name: r.entry.name });
      }
    }
    // A member he matched is named by it, so the other changes find him.
    const listNameOf = new Map(matched.map((m) => [m.userId, m.name]));
    const rows = applySeedChanges(next.rows, answer.changes, (id) => nameOf(id) || listNameOf.get(id) || "");
    next = { ...next, rows };
    const { nameMemberFromList, seedDmText } = await import("./month-seed-match");
    for (const m of matched) await nameMemberFromList(proposal.orgId, m.userId, m.name);
    const { text, nameless: renumbered } = await seedDmText({ orgId: proposal.orgId, lang, monthStart: proposal.monthStart, data: next, hq: !!org?.adminGroupId });
    next = { ...next, nameless: renumbered };
    const res = await db.adminSquadProposal.updateMany({
      where: { id: proposal.id, resolvedAt: null },
      data: { monthSeed: next as unknown as object, playingUserIds: rows.map((r) => r.userId), expiresAt: new Date(now.getTime() + MONTH_SEED_DM_TTL_MS) },
    });
    if (res.count === 0) return null;
    await db.sentNotification.updateMany({ where: { kind: MONTH_SEED_DM_KIND, key: `org-${proposal.orgId}:month-seed-dm:${proposal.id}` }, data: { text } });
    await send(text);
    console.info(`[${LABEL}] proposal=${proposal.id} changed: ${answer.changes.length} change(s), ${matched.length} name(s) matched`);
    return { handled: "month-seed-changed", monthStart: proposal.monthStart };
  }

  // Answered: claimed once, so a second delivery of the same DM does nothing.
  const claimed = await db.adminSquadProposal.updateMany({
    where: { id: proposal.id, resolvedAt: null },
    data: { resolvedAt: now, outcome: answer.kind === "yes" ? "confirmed" : "declined" },
  });
  if (claimed.count === 0) return null;
  if (answer.kind === "no") {
    await send(t(lang).mwk_dm_seed_declined({ month }));
    return { handled: "month-seed-declined", monthStart: proposal.monthStart };
  }
  // The draft as it stands NOW, read after the claim: a correction that
  // landed while his yes was being read is in it, and none can land after.
  const latest = await db.adminSquadProposal.findUnique({ where: { id: proposal.id }, select: { monthSeed: true } });
  const { applyMonthSeedYes } = await import("./month-seed-hq");
  const r = await applyMonthSeedYes({ orgId: proposal.orgId, lang, proposal: { monthStart: proposal.monthStart, monthSeed: latest?.monthSeed ?? data }, senderUserId: userId, now });
  await send(r.replyText);
  return { handled: r.outcome === "month-seed-applied" ? "month-seed-started" : "month-seed-failed", monthStart: proposal.monthStart };
}
