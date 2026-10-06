/**
 * F3, learned setup: the owner's line on /admin/clubs, pure. What was read,
 * what was switched (and undone), what was only suggested ("organisers
 * pick" with the chat messages behind it), the monthly
 * list when it was seen (with its evidence: that pattern is the one we
 * are counting), and what the call cost.
 */
import type { AppliedItem, KeptItem, NotedPattern, Suggestion } from "./rules";

export interface LearningRow {
  status: string;
  reason: string | null;
  messageCount: number;
  applied: unknown;
  suggestions: unknown;
  noted: unknown;
  kept: unknown;
  costUsd: number | null;
  dmQueuedAt: Date | null;
}

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function ownerLearningSummary(row: LearningRow | null): { line: string; monthly: string | null } {
  if (!row) return { line: "Chat not read yet.", monthly: null };
  if (row.status === "running") return { line: "Reading the chat now.", monthly: null };
  if (row.status === "deferred") return { line: `Waiting to read the chat (${row.reason ?? "retry"}).`, monthly: null };
  if (row.status === "failed") return { line: `Could not read the chat (${row.reason ?? "error"}). Nothing changed.`, monthly: null };
  if (row.status === "skipped") {
    return { line: `Chat not read: ${row.reason ?? "skipped"} (${row.messageCount} messages). Nothing changed.`, monthly: null };
  }
  const applied = arr<AppliedItem>(row.applied);
  const kept = arr<KeptItem>(row.kept);
  const suggestions = arr<Suggestion>(row.suggestions);
  const noted = arr<NotedPattern>(row.noted);
  const parts = [`Read ${row.messageCount} messages.`];
  parts.push(
    applied.length > 0
      ? `Set: ${applied.map((a) => `${a.key}${a.undoneAt ? " (undone)" : ""}`).join(", ")}.`
      : `Set nothing${row.reason === "not-a-game-group" ? " (not a game group)" : ""}.`,
  );
  if (kept.length > 0) parts.push(`Left alone: ${kept.map((k) => `${k.key} (${k.reason})`).join(", ")}.`);
  // "Organisers pick" is never switched (rules.ts, rule 4): its evidence is shown, to see how often it is right.
  const suggested = (s: Suggestion) =>
    s.key === "organiserPicks" && arr<string>(s.evidence).length > 0
      ? `${s.key} (${arr<string>(s.evidence).map((q) => `"${q}"`).join(", ")})`
      : s.key;
  if (suggestions.length > 0) parts.push(`Suggested: ${suggestions.map(suggested).join(", ")}.`);
  if (row.costUsd != null) parts.push(`Cost $${row.costUsd.toFixed(4)}.`);
  parts.push(row.dmQueuedAt ? "Organiser told." : "No DM.");
  const m = noted.find((n) => n.key === "monthlyList");
  const monthly = m
    ? `Monthly list (${m.confidence}): ` +
      [m.prepayForMonth && "prepay", m.payAsYouGoFillIns && "PAYG fill-ins", m.creditForMissedGames && "credits"]
        .filter(Boolean)
        .join(", ") +
      (m.evidence.length > 0 ? `. From: ${m.evidence.map((q) => `"${q}"`).join(", ")}` : "")
    : null;
  return { line: parts.join(" "), monthly };
}
