/**
 * Pure reconciliation helpers for the onboarding enrichment pass.
 *
 * These take the analyser output + the org's current members and produce
 * the JSON blobs persisted on OnboardingSession (proposedRoster,
 * unresolvedMembers) — plus a ParsedChat builder so the analyser can be
 * fed from stored chat history rather than a raw .txt export.
 *
 * Everything here is deliberately DB-free and deterministic so it can be
 * unit-tested in isolation (the DB-touching orchestration lives in
 * onboarding-enrichment.ts).
 */

import type { ParsedChat, ParsedMessage, ParsedAuthor } from "./whatsapp-parser";

/** A single chat message as stored in MatchTime history. */
export interface HistoryMessage {
  author: string;
  authorPhone?: string | null;
  text: string;
  timestamp: string | number | Date;
}

/** One reconciled roster proposal, persisted to OnboardingSession.proposedRoster. */
export interface ProposedRosterEntry {
  name: string;
  matchedUserId: string | null;
  proposedPosition: string | null;
  proposedSeedRating: number | null;
  evidence: string;
  confidence: number;
}

/** Best-guess match schedule, persisted to OnboardingSession.capturedSchedule. */
export interface CapturedSchedule {
  dayOfWeek?: number | null;
  time?: string | null;
  venue?: string | null;
  playersPerSide?: number | null;
  capacity?: number | null;
}

const nameKey = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase();

/**
 * Defensively coerce an arbitrary value (a request body field or a Prisma
 * `Json` column) into a clean HistoryMessage[]. Used by /bot-added (to
 * validate the Pi's enrichmentHistory before persisting it as
 * capturedHistory) and by completeOnboarding (to read that stored column
 * back at completion). Mirrors what buildParsedChatFromHistory/
 * runOnboardingEnrichment expect:
 *   - non-objects are skipped,
 *   - rows with a blank author OR blank text are skipped,
 *   - chronological order is preserved as-given (the Pi orders oldest→
 *     newest; we never reorder),
 *   - timestamp passes through as-is (HistoryMessage.timestamp is
 *     string | number | Date; a missing one defaults to now()).
 * Returns [] for anything unusable.
 */
export function coerceHistoryMessages(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value)) return [];
  const out: HistoryMessage[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const author = typeof r.author === "string" ? r.author.trim() : "";
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (!author || !text) continue;
    const authorPhone =
      typeof r.authorPhone === "string" && r.authorPhone.trim()
        ? r.authorPhone.trim()
        : null;
    const ts = r.timestamp;
    const timestamp: string | number | Date =
      typeof ts === "string" || typeof ts === "number"
        ? ts
        : ts instanceof Date
          ? ts
          : Date.now();
    out.push({ author, authorPhone, text, timestamp });
  }
  return out;
}

/**
 * Build a ParsedChat from stored history. Mirrors the shape that
 * parseWhatsAppChat produces, but from already-structured rows rather than
 * a raw export. Blank-author / blank-text rows are skipped; everything is
 * treated as a non-system message.
 */
export function buildParsedChatFromHistory(history: HistoryMessage[]): ParsedChat {
  const recentMessages: ParsedMessage[] = [];

  for (const h of history) {
    const author = (h.author ?? "").trim();
    const body = (h.text ?? "").trim();
    if (!author || !body) continue;
    recentMessages.push({
      timestamp: new Date(h.timestamp),
      author,
      body,
      system: false,
    });
  }

  // Aggregate authors by display name.
  const byAuthor = new Map<string, ParsedAuthor>();
  for (const m of recentMessages) {
    const key = nameKey(m.author);
    const existing = byAuthor.get(key);
    if (existing) {
      existing.messageCount += 1;
      if (m.timestamp < existing.firstSeen) existing.firstSeen = m.timestamp;
      if (m.timestamp > existing.lastSeen) existing.lastSeen = m.timestamp;
    } else {
      byAuthor.set(key, {
        name: m.author!,
        phone: null,
        messageCount: 1,
        firstSeen: m.timestamp,
        lastSeen: m.timestamp,
      });
    }
  }
  const authors = Array.from(byAuthor.values()).sort(
    (a, b) => b.messageCount - a.messageCount,
  );

  const firstMessageAt =
    recentMessages.length > 0 ? recentMessages[0].timestamp : null;
  const lastMessageAt =
    recentMessages.length > 0
      ? recentMessages[recentMessages.length - 1].timestamp
      : null;

  return {
    groupName: null,
    firstMessageAt,
    lastMessageAt,
    totalMessages: recentMessages.length,
    systemMessageCount: 0,
    authors,
    recentMessages,
  };
}

/**
 * Reconcile analyser players against the org's members by name
 * (case-insensitive, trimmed). Unmatched players are kept with
 * matchedUserId: null so the admin can still review them (Apply will skip
 * rating/position writes for null matches until a phone resolves them).
 */
export function reconcileProposals(
  analysisPlayers: {
    name: string;
    position: string | null;
    seedRating: number | null;
    evidence: string;
    confidence: number;
  }[],
  members: { id: string; name: string | null }[],
): ProposedRosterEntry[] {
  const byName = new Map<string, string>();
  for (const m of members) {
    const key = nameKey(m.name);
    if (!key) continue;
    // First member wins for a given name; ambiguous duplicates are rare and
    // the admin reviews the proposal anyway.
    if (!byName.has(key)) byName.set(key, m.id);
  }

  return analysisPlayers.map((p) => ({
    name: p.name,
    matchedUserId: byName.get(nameKey(p.name)) ?? null,
    proposedPosition: p.position ?? null,
    proposedSeedRating: p.seedRating ?? null,
    evidence: p.evidence,
    confidence: p.confidence,
  }));
}

/**
 * Members with no phone number — rating/positions can't be meaningfully
 * applied to them until a phone is added, so the admin needs to resolve
 * them first.
 */
export function detectUnresolvedMembers(
  members: { id: string; name: string | null; phoneNumber: string | null }[],
): { name: string | null; userId: string }[] {
  return members
    .filter((m) => !m.phoneNumber)
    .map((m) => ({ userId: m.id, name: m.name }));
}
