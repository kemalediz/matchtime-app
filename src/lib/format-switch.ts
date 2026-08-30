/**
 * FORMAT-SWITCH arithmetic — pure, no DB, no LLM.
 *
 * When a squad is short, MatchTime may suggest dropping to a smaller
 * format ("switch to 5-a-side"). Two facts fall out of that suggestion:
 * whether the squad would actually FILL the smaller format, and exactly
 * WHO loses their confirmed slot. Both are deterministic consequences of
 * the roster order and the format's capacity — the same rule
 * `switchMatchFormat` (src/app/actions/matches.ts) applies for real:
 * sort by position, the first `maxPlayers` stay CONFIRMED, the rest go
 * to the BENCH.
 *
 * WHY THIS FILE EXISTS (2026-08-30 production incident)
 * -----------------------------------------------------
 * The proposal sentence used to be composed by the LLM, from a prompt
 * that told it to "use the LAST N confirmed names (N = confirmedCount -
 * smallerFormatTotal)". With EIGHT confirmed players the model posted
 * this to a real customer group:
 *
 *   "If we don't find 6 more, we could switch to 5-a-side (10 players)
 *    — Najib + Mojib + Mustafa go on the bench."
 *
 * It had computed 8 - 5 (players per TEAM) instead of 8 - 10 (the format
 * TOTAL), so it named three real people as losing their place when a
 * switch would have benched nobody — and 8 does not even fill a 10-player
 * format, so the switch should never have been proposed at all. The
 * sentence contradicted itself: "(10 players)" then three of eight
 * benched.
 *
 * So: the model no longer does this arithmetic and no longer picks the
 * names. Code computes both and hands the model a finished sentence to
 * reproduce verbatim (see renderFormatSwitchContext + the FORMAT SWITCH
 * section of the analyzer prompt). "LLM extracts, code decides."
 *
 * CAPACITY UNITS — read this before touching anything here
 * --------------------------------------------------------
 * `totalPlayers` throughout this module is the format TOTAL — both teams
 * — i.e. `sport.playersPerTeam * 2`, the exact semantics of
 * `Match.maxPlayers`. It is NEVER players-per-team. "5-a-side" is 10.
 */

/** One smaller format the org has configured as an Activity. */
export interface SmallerFormat {
  /** Sport display name, e.g. "Football 5-a-side". */
  sportName: string;
  /** TOTAL players across BOTH teams (playersPerTeam * 2). Not per-team. */
  totalPlayers: number;
}

/** A fully-resolved, code-computed answer for one smaller format. */
export interface FormatSwitchFact extends SmallerFormat {
  /** Size of the confirmed squad the facts were computed against. */
  confirmedCount: number;
  /** Exactly who loses their confirmed slot, in position order. Empty
   *  when the squad fits inside the smaller format. */
  benched: string[];
  /** Would the confirmed squad actually FILL this format? A switch is
   *  only worth proposing when it does. */
  fills: boolean;
  /**
   * The complete, ready-to-post proposal line — composed by code, never
   * by the model. null when there is nothing to propose (the squad is
   * already full, or the smaller format wouldn't be filled either).
   */
  proposal: string | null;
}

/** Format capacity from players-per-team. The ONLY correct conversion. */
export function totalPlayersFor(playersPerTeam: number): number {
  return playersPerTeam * 2;
}

/** Capacity, defensively coerced: never negative, never fractional, and
 *  never NaN (a bad value must under-report capacity, not throw inside a
 *  live reply path). */
function capacity(totalPlayers: number): number {
  return Number.isFinite(totalPlayers)
    ? Math.max(0, Math.floor(totalPlayers))
    : 0;
}

/**
 * Who moves from the confirmed squad to the bench if the match switches
 * to a format that fields `smallerFormatTotal` players IN TOTAL.
 *
 * The last `max(0, confirmedCount - smallerFormatTotal)` names, in the
 * order given (which callers must supply as Attendance position order,
 * matching what switchMatchFormat actually does).
 *
 * Returns an EMPTY array when the squad already fits — and when it does,
 * the caller must not produce a "goes on the bench" clause at all.
 */
export function benchedOnFormatSwitch(
  confirmedNames: readonly string[],
  smallerFormatTotal: number,
): string[] {
  const keep = capacity(smallerFormatTotal);
  if (confirmedNames.length <= keep) return [];
  return confirmedNames.slice(keep);
}

/** "Football 5-a-side" → "5-a-side"; a single-word sport stays as-is. */
function shortFormatName(sportName: string): string {
  const parts = sportName.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : sportName.trim();
}

/** "A", "A + B", "A + B + C" — the group-chat house style. */
function joinNames(names: readonly string[]): string {
  return names.join(" + ");
}

/**
 * Compute the code-owned facts for every alternative format.
 *
 * `confirmedNames` MUST be in Attendance position order (earliest IN
 * first) — the bench overflow is defined by that order.
 */
export function buildFormatSwitchFacts(args: {
  confirmedNames: readonly string[];
  /** The CURRENT match's maxPlayers (also a total, e.g. 14 for 7-a-side). */
  currentMaxPlayers: number;
  alternatives: readonly SmallerFormat[];
}): FormatSwitchFact[] {
  const confirmedCount = args.confirmedNames.length;
  const shortBy = Math.max(0, capacity(args.currentMaxPlayers) - confirmedCount);

  return args.alternatives.map((alt) => {
    const total = capacity(alt.totalPlayers);
    const benched = benchedOnFormatSwitch(args.confirmedNames, total);
    const fills = confirmedCount >= total;

    let proposal: string | null = null;
    // Only worth proposing when the squad is actually SHORT and the
    // smaller format would actually be filled.
    if (fills && shortBy > 0) {
      const lead =
        `If we don't find ${shortBy} more, we could switch to ` +
        `${shortFormatName(alt.sportName)} (${total} players) — `;
      const tail = " Admins can rebook and flip it in the portal.";
      proposal =
        benched.length === 0
          ? `${lead}all ${confirmedCount} of you still play, nobody goes on the bench.${tail}`
          : `${lead}${joinNames(benched)} ${
              benched.length === 1 ? "goes" : "go"
            } on the bench.${tail}`;
    }

    return {
      sportName: alt.sportName,
      totalPlayers: total,
      confirmedCount,
      benched,
      fills,
      proposal,
    };
  });
}

/**
 * Render the facts as Match-Context lines for the LLM.
 *
 * The wording is deliberately blunt: the model's ONLY job here is to
 * copy. It must not add, subtract, or choose a name.
 */
export function renderFormatSwitchContext(
  facts: readonly FormatSwitchFact[],
): string[] {
  if (facts.length === 0) return [];

  const lines: string[] = [
    "Alternative formats available for this sport:",
    "  (SERVER-COMPUTED — the arithmetic and the bench names below were worked out in code.",
    "   NEVER recompute them, NEVER count players yourself, NEVER choose who goes on the bench.)",
  ];

  for (const f of facts) {
    lines.push(`  - ${f.sportName} (${f.totalPlayers} players total)`);
    if (!f.fills) {
      lines.push(
        `      ❌ NOT VIABLE — only ${f.confirmedCount} confirmed and this format needs ` +
          `${f.totalPlayers} to field a match. Do NOT propose this switch.`,
        `      Bench on switch: NOBODY.`,
      );
      continue;
    }
    lines.push(
      `      ✅ VIABLE — ${f.confirmedCount} confirmed fills ${f.totalPlayers}.`,
      f.benched.length === 0
        ? `      Bench on switch: NOBODY — all ${f.confirmedCount} still play. Do NOT write a "goes on the bench" clause for this format.`
        : `      Bench on switch (${f.benched.length}, this exact list, this exact order): ${f.benched.join(", ")}`,
    );
    if (f.proposal) {
      lines.push(
        `      If you propose this switch, use this EXACT line VERBATIM:`,
        `      "${f.proposal}"`,
      );
    }
  }

  lines.push(
    "Admins switch by rebooking the venue and flipping the match in the portal; " +
      "a switch converts everyone above the new cap from confirmed to bench, keeping their order.",
  );
  return lines;
}
