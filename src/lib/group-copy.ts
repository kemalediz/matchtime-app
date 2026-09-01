/**
 * PURE group-post copy. No database, no model, no clock.
 *
 * Both functions here were already pure and already correct; they were
 * simply living in files that import the Prisma client
 * (`message-analyzer.ts` → `./db`, `team-generation.ts` → `./db`), which
 * makes them unreachable from anywhere that must not load Prisma — the
 * Playwright worker process being the one that matters right now
 * (`e2e/sim/group.ts`: "plain SQL via the pg helper — no Prisma in the
 * Playwright process").
 *
 * Moved VERBATIM. Both original modules re-export them, so every
 * existing import keeps working and no call site changed. §13 lists
 * `composeSquadStatusPost()` under "what must not change": *"Already
 * correct. Promoted, not rewritten."* This is the promotion, and the
 * byte-stability the sim suite asserts on is preserved.
 */

/**
 * Deterministic, server-composed squad+bench status post. Used when a
 * batch produced MULTIPLE squad-state replies: they all collapse into
 * this single message, computed from a FRESH DB snapshot taken AFTER
 * every attendance write in the batch has been applied — so it can
 * never contradict itself or the database (Kemal's chosen design,
 * 2026-06-12: "examine all messages in the window as a whole, then post
 * ONE clear message with the latest squad and bench").
 */
export function composeSquadStatusPost(args: {
  confirmed: string[];
  bench: string[];
  maxPlayers: number;
}): string {
  const { confirmed, bench, maxPlayers } = args;
  const need = Math.max(0, maxPlayers - confirmed.length);
  const count = `*${confirmed.length}/${maxPlayers}*`;
  const lead =
    `📋 Based on all the messages I've picked up, here's the latest squad${bench.length > 0 ? " and bench" : ""} — ` +
    (need > 0 ? `${count}, need *${need} more* 🙏` : `${count} ✅ full squad.`);
  const rows: string[] = [];
  for (let i = 0; i < maxPlayers; i++) {
    rows.push(i < confirmed.length ? `${i + 1}. ${confirmed[i]}` : `${i + 1}. 🥁`);
  }
  const lines = [lead, "", "*Playing:*", ...rows];
  if (bench.length > 0) {
    lines.push("", `*Bench (${bench.length}):*`);
    bench.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  }
  return lines.join("\n");
}

/**
 * Pure formatter for the group "teams" post. Single source of truth for
 * the message layout, shared by `generateTeamsForMatch` (after balancing)
 * and the analyze route's "show the teams again" re-post path (which
 * reads the EXISTING assignments verbatim — no balancer). Keep the output
 * byte-stable: the sim suite asserts on its substrings.
 */
export function formatTeamsPost(args: {
  redLabel: string;
  yellowLabel: string;
  red: { name: string }[];
  yellow: { name: string }[];
  kickoff: string;
  venue: string;
}): string {
  const listFor = (arr: { name: string }[]) =>
    arr.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  return (
    `⚽ *Teams for tonight* — ${args.kickoff} at ${args.venue}\n\n` +
    `*${args.redLabel}*:\n${listFor(args.red)}\n\n` +
    `*${args.yellowLabel}*:\n${listFor(args.yellow)}\n\n` +
    `Objections? Reply \`swap X Y\` — admin will confirm.`
  );
}
