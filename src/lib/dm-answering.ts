/**
 * WHICH OF MATCHTIME'S MESSAGES A DM ANSWERS (2026-10-29, review of #465):
 * the one he swipe-replied to, else MatchTime's newest DM to him. A fact
 * about the conversation, never a reading of his words. The DM steps that
 * wait for an answer (the paid-claims list, the month's draft, a mid-month
 * join) act only when it is THEIR message being answered.
 */
import { db } from "./db";

export async function latestBotDmText(phones: Array<string | null | undefined>): Promise<string | null> {
  const bare = [...new Set(phones.map((p) => (typeof p === "string" ? p.replace(/\D/g, "") : "")).filter(Boolean))];
  if (bare.length === 0) return null;
  const job = await db.botJob.findFirst({
    where: { kind: "dm", phone: { in: bare } },
    orderBy: { createdAt: "desc" },
    select: { text: true },
  });
  return job?.text ?? null;
}

/** A memoised "which message is he answering", read at most once per DM. */
export function answeringOnce(quotedText: string | null | undefined, phones: Array<string | null | undefined>): () => Promise<string | null> {
  let memo: Promise<string | null> | null = null;
  return () => (memo ??= quotedText?.trim() ? Promise.resolve(quotedText) : latestBotDmText(phones));
}
