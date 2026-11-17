/**
 * WHO PLAYS WITH WHOM: "together" and "apart" as hard constraints on the
 * two teams (2026-11-16, the Vets: "@Match Time generate the teams, put Dan
 * and Craig in separate teams please" was read with no way to say "apart",
 * so the request was silently ignored).
 *
 *   together  a group of players who must share a side.
 *   apart     a group of players who must be split: two people on
 *             different sides; a bigger group spread as evenly as two sides
 *             allow (three is two and one, four is two and two).
 *
 * Every id here is a resolved user id; names never reach this file. Pure:
 * no database, no model.
 *
 * Two jobs:
 *
 *   `constraintPins`        new teams (`balanceTeams`): turns the groups,
 *                           together with any pins, into a side for every
 *                           constrained player, chosen so the sizes fit and
 *                           the ratings balance best. The balancer then
 *                           drafts everyone else around them as it always
 *                           has.
 *   `planConstraintChange`  teams that already exist: the fewest swaps
 *                           that meet the groups, the ratings as close as
 *                           those swaps allow. Never a rebuild.
 *
 * Neither can always meet every group (together and apart about the same
 * two people; a group bigger than a side; somebody not playing). Then each
 * does the best it can, and `unmetConstraints` reads which groups the
 * result breaks, FROM THE RESULT, so what MatchTime says can never
 * disagree with the teams it made.
 */
import { t } from "./i18n/t";
import { joinList } from "./i18n/text";
import type { Lang } from "./i18n/lang";
import { resolveSwapSideDetailed, type SideResolution, type SwapCandidate } from "./team-slot-swap";
import type { PersonPicks } from "./pipeline/who-is-who";

export type SlotSide = "RED" | "YELLOW";

export interface TeamConstraints {
  together?: string[][];
  apart?: string[][];
}

/**
 * Why a group could not be kept, so what MatchTime says is TRUE (review of
 * #619: never blame a clash that does not exist):
 *
 *   not-on-teams  a member has no place on the teams (bench, dropped, not
 *                 in the squad); `missing` names them;
 *   clash         it contradicts a pin, a player the message placed or
 *                 moved, or another group in the same message;
 *   sizes         the groups cannot fit the two side sizes;
 *   no-swaps      teams as they stand: no change of a few swaps does it.
 */
export type UnmetReason = "not-on-teams" | "clash" | "sizes" | "no-swaps";
export interface UnmetWhy {
  reason: UnmetReason;
  /** For not-on-teams: the members with no place. */
  missing?: string[];
}

export interface UnmetConstraints {
  together: string[][];
  apart: string[][];
  /** Why each unmet group failed, by `groupKey`. Absent: not known. */
  why?: Record<string, UnmetWhy>;
}

/** One key per group, whatever order its members were named in. */
export function groupKey(kind: "together" | "apart", ids: string[]): string {
  return `${kind}:${[...ids].sort().join("\u0000")}`;
}

/** Each group with its ids once each; a group of fewer than two dropped. */
export function cleanGroups(groups: string[][] | undefined): string[][] {
  return (groups ?? []).map((g) => [...new Set(g.filter(Boolean))]).filter((g) => g.length >= 2);
}

/**
 * Why each unmet group failed: a member with no side first (that is the
 * truest answer), then what `known` says, else nothing.
 */
export function explainUnmet(
  unmet: UnmetConstraints,
  sideOf: (id: string) => SlotSide | undefined | null,
  known: ReadonlyMap<string, UnmetReason>,
): UnmetConstraints {
  const why: Record<string, UnmetWhy> = {};
  for (const [kind, groups] of [
    ["together", unmet.together],
    ["apart", unmet.apart],
  ] as const) {
    for (const g of groups) {
      const key = groupKey(kind, g);
      const missing = g.filter((id) => !sideOf(id));
      if (missing.length > 0) why[key] = { reason: "not-on-teams", missing };
      else if (known.has(key)) why[key] = { reason: known.get(key)! };
    }
  }
  return { ...unmet, why };
}

/**
 * The groups a placement breaks. A member with no side (not in the squad,
 * not on the teams) breaks their group.
 */
export function unmetConstraints(sideOf: (id: string) => SlotSide | undefined | null, c: TeamConstraints): UnmetConstraints {
  const together = cleanGroups(c.together).filter((g) => {
    const sides = g.map(sideOf);
    return sides.some((s) => !s) || new Set(sides).size > 1;
  });
  const apart = cleanGroups(c.apart).filter((g) => {
    const sides = g.map(sideOf);
    if (sides.some((s) => !s)) return true;
    const red = sides.filter((s) => s === "RED").length;
    return Math.abs(red - (g.length - red)) > g.length % 2;
  });
  return { together, apart };
}

export const noneUnmet = (u: UnmetConstraints | undefined): boolean => !u || (u.together.length === 0 && u.apart.length === 0);

// ── New teams ──────────────────────────────────────────────────────────

/**
 * Union-find with parity: two players in one set are on the same side
 * (parity 0) or on opposite sides (parity 1). The anchor stands for Red,
 * so a pin is an edge to it.
 */
class ParityUnion {
  private parent = new Map<string, string>();
  private parity = new Map<string, number>();

  find(x: string): { root: string; parity: number } {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.parity.set(x, 0);
    }
    let p = 0;
    let cur = x;
    const path: string[] = [];
    while (this.parent.get(cur) !== cur) {
      path.push(cur);
      cur = this.parent.get(cur)!;
    }
    // Compress: each node on the path points at the root with its parity.
    let acc = 0;
    for (let i = path.length - 1; i >= 0; i--) {
      acc ^= this.parity.get(path[i])!;
      this.parity.set(path[i], acc);
      this.parent.set(path[i], cur);
    }
    p = path.length ? this.parity.get(x)! : 0;
    return { root: cur, parity: p };
  }

  /** Join a and b with this parity. False, and nothing joined, on a clash. */
  union(a: string, b: string, parity: number): boolean {
    const A = this.find(a);
    const B = this.find(b);
    if (A.root === B.root) return (A.parity ^ B.parity) === parity;
    this.parent.set(B.root, A.root);
    this.parity.set(B.root, A.parity ^ B.parity ^ parity);
    return true;
  }
}

const ANCHOR = "\u0000RED";
/** Above this many free groups the orientations are chosen greedily. */
const MAX_ENUMERATED = 12;

/**
 * A side for every constrained player of a new draft, and for every pin:
 *
 *   1. pins first, capped at each side's size in squad order (as the
 *      balancer always capped them);
 *   2. then each together group, then each apart group, in the order
 *      given; an edge that clashes with what is already joined is skipped
 *      (the group is then reported unmet, from the result);
 *   3. if the joined groups cannot fit the two side sizes in any way, the
 *      last group is dropped and the rest tried again;
 *   4. of the ways the groups can sit, the one whose quick draft has the
 *      closest ratings.
 *
 * The result is a pin map the balancer honours as it honours any pin.
 */
export function constraintPins(args: {
  /** The players being drafted, in squad order. */
  ids: string[];
  pins: Record<string, SlotSide>;
  together?: string[][];
  apart?: string[][];
  sides: { red: number; yellow: number };
  rating: (id: string) => number;
  /** Filled with why a group was not kept: a clash, or the sizes. */
  report?: Map<string, UnmetReason>;
}): Record<string, SlotSide> {
  const inSquad = new Set(args.ids);
  // 1. Pins, capped, exactly as the balancer's own first step.
  const pins: Record<string, SlotSide> = {};
  const count = { RED: 0, YELLOW: 0 };
  for (const id of args.ids) {
    const t = args.pins[id];
    if (!t) continue;
    if (count[t] >= (t === "RED" ? args.sides.red : args.sides.yellow)) continue;
    pins[id] = t;
    count[t]++;
  }

  type Group = { ids: string[]; apart: boolean; key: string };
  const groups: Group[] = [
    ...cleanGroups(args.together).map((g) => ({ ids: g.filter((id) => inSquad.has(id)), apart: false, key: groupKey("together", g) })),
    ...cleanGroups(args.apart).map((g) => ({ ids: g.filter((id) => inSquad.has(id)), apart: true, key: groupKey("apart", g) })),
  ].filter((g) => g.ids.length >= 2);
  if (groups.length === 0) return { ...pins };

  for (let active = groups.length; active >= 0; active--) {
    const clashed = new Set<string>();
    const placed = tryPlace(pins, groups.slice(0, active), args, clashed);
    if (placed) {
      for (const key of clashed) args.report?.set(key, "clash");
      // Dropped because the groups could not fit the two sides together.
      for (const g of groups.slice(active)) if (!args.report?.has(g.key)) args.report?.set(g.key, "sizes");
      return placed;
    }
  }
  return { ...pins };
}

/** Join the groups in order; a group whose edge contradicts what is
 *  already joined goes into `clashed`. */
function joinGroups(uf: ParityUnion, groups: Array<{ ids: string[]; apart: boolean; key: string }>, clashed: Set<string>) {
  for (const g of groups) {
    let ok = true;
    if (g.apart) {
      // Pairs in order (1st with 2nd, 3rd with 4th, ...): each pair split,
      // so the group is as even as two sides allow.
      for (let i = 0; i + 1 < g.ids.length; i += 2) ok = uf.union(g.ids[i], g.ids[i + 1], 1) && ok;
    } else {
      for (let i = 1; i < g.ids.length; i++) ok = uf.union(g.ids[0], g.ids[i], 0) && ok;
    }
    if (!ok) clashed.add(g.key);
  }
}

function tryPlace(
  pins: Record<string, SlotSide>,
  groups: Array<{ ids: string[]; apart: boolean; key: string }>,
  args: { ids: string[]; sides: { red: number; yellow: number }; rating: (id: string) => number },
  clashed: Set<string>,
): Record<string, SlotSide> | null {
  const uf = new ParityUnion();
  uf.find(ANCHOR);
  for (const [id, t] of Object.entries(pins)) uf.union(ANCHOR, id, t === "RED" ? 0 : 1);
  joinGroups(uf, groups, clashed);

  // The sets: the anchored one (fixed sides) and the free ones (two ways each).
  const constrained = new Set<string>([...Object.keys(pins), ...groups.flatMap((g) => g.ids)]);
  const anchorRoot = uf.find(ANCHOR).root;
  const anchoredRed: string[] = [];
  const anchoredYellow: string[] = [];
  const free = new Map<string, { zero: string[]; one: string[] }>();
  for (const id of constrained) {
    const { root, parity } = uf.find(id);
    if (root === anchorRoot) {
      const anchorParity = uf.find(ANCHOR).parity;
      ((parity ^ anchorParity) === 0 ? anchoredRed : anchoredYellow).push(id);
      continue;
    }
    if (!free.has(root)) free.set(root, { zero: [], one: [] });
    (parity === 0 ? free.get(root)!.zero : free.get(root)!.one).push(id);
  }
  const sets = [...free.values()];
  if (anchoredRed.length > args.sides.red || anchoredYellow.length > args.sides.yellow) return null;

  const others = args.ids.filter((id) => !constrained.has(id));
  const sum = (ids: string[]) => ids.reduce((a, id) => a + args.rating(id), 0);

  /** The gap a greedy draft of everyone else leaves, for one way of sitting the sets. */
  const score = (red: string[], yellow: string[]): number | null => {
    if (red.length > args.sides.red || yellow.length > args.sides.yellow) return null;
    let r = sum(red);
    let y = sum(yellow);
    let rn = red.length;
    let yn = yellow.length;
    for (const id of [...others].sort((a, b) => args.rating(b) - args.rating(a))) {
      if (rn >= args.sides.red || (yn < args.sides.yellow && y < r)) {
        y += args.rating(id);
        yn++;
      } else {
        r += args.rating(id);
        rn++;
      }
    }
    return Math.abs(r - y);
  };

  let best: { red: string[]; yellow: string[]; gap: number } | null = null;
  const consider = (red: string[], yellow: string[]) => {
    const gap = score(red, yellow);
    if (gap === null) return;
    if (!best || gap < best.gap - 1e-9) best = { red, yellow, gap };
  };

  if (sets.length <= MAX_ENUMERATED) {
    // With nothing anchored AND sides of one size, the mirror image is the
    // same teams: fix the first set. With 7 against 6 it is not (review of
    // #619): both ways round are tried.
    const fixFirst =
      anchoredRed.length === 0 && anchoredYellow.length === 0 && sets.length > 0 && args.sides.red === args.sides.yellow;
    const combos = 1 << sets.length;
    for (let mask = 0; mask < combos; mask++) {
      if (fixFirst && mask & 1) continue;
      const red = [...anchoredRed];
      const yellow = [...anchoredYellow];
      sets.forEach((s, i) => {
        const flip = (mask >> i) & 1;
        red.push(...(flip ? s.one : s.zero));
        yellow.push(...(flip ? s.zero : s.one));
      });
      consider(red, yellow);
    }
  } else {
    // Greedy: biggest sets first, each the way that fits and leaves Red lighter.
    const red = [...anchoredRed];
    const yellow = [...anchoredYellow];
    for (const s of [...sets].sort((a, b) => b.zero.length + b.one.length - (a.zero.length + a.one.length))) {
      const fitsA = red.length + s.zero.length <= args.sides.red && yellow.length + s.one.length <= args.sides.yellow;
      const fitsB = red.length + s.one.length <= args.sides.red && yellow.length + s.zero.length <= args.sides.yellow;
      if (!fitsA && !fitsB) return null;
      const a = Math.abs(sum(red) + sum(s.zero) - sum(yellow) - sum(s.one));
      const b = Math.abs(sum(red) + sum(s.one) - sum(yellow) - sum(s.zero));
      const useA = fitsA && (!fitsB || a <= b);
      red.push(...(useA ? s.zero : s.one));
      yellow.push(...(useA ? s.one : s.zero));
    }
    consider(red, yellow);
  }
  if (!best) return null;
  const chosen = best as { red: string[]; yellow: string[] };
  const out: Record<string, SlotSide> = {};
  for (const id of chosen.red) out[id] = "RED";
  for (const id of chosen.yellow) out[id] = "YELLOW";
  return out;
}

// ── Teams that already exist ──────────────────────────────────────────

export interface ConstraintChangePlan {
  /** Every slot holder's side after the change. */
  team: Map<string, SlotSide>;
  /** The swaps made, in order: [one who went across, one who came back]. */
  swaps: Array<[string, string]>;
  /** The groups the teams still break after the change. */
  unmet: UnmetConstraints;
}

/** The most swaps tried to meet the groups. */
const MAX_SWAPS = 4;
/** The most placements one search level may try (about 50 ms). */
const SEARCH_BUDGET = 400_000;

/**
 * Why each group of a change to the teams as they stand cannot be met, when
 * it cannot: a contradiction with a fixed player or an earlier group
 * ("clash"), a component too big for the sides ("sizes"), and otherwise
 * the search simply found no way in a few swaps ("no-swaps").
 */
function diagnoseExisting(
  c: { together: string[][]; apart: string[][] },
  fixed: ReadonlyMap<string, SlotSide>,
  sides: { red: number; yellow: number },
): Map<string, UnmetReason> {
  const groups = [
    ...c.together.map((g) => ({ ids: g, apart: false, key: groupKey("together", g) })),
    ...c.apart.map((g) => ({ ids: g, apart: true, key: groupKey("apart", g) })),
  ];
  const uf = new ParityUnion();
  uf.find(ANCHOR);
  for (const [id, side] of fixed) uf.union(ANCHOR, id, side === "RED" ? 0 : 1);
  const clashed = new Set<string>();
  joinGroups(uf, groups, clashed);

  // Each joined set's two halves, the anchored one with fixed sides.
  const anchorRoot = uf.find(ANCHOR).root;
  const anchorParity = uf.find(ANCHOR).parity;
  const halves = new Map<string, [number, number]>();
  for (const id of new Set(groups.flatMap((g) => g.ids))) {
    const { root, parity } = uf.find(id);
    const h = halves.get(root) ?? [0, 0];
    h[root === anchorRoot ? parity ^ anchorParity : parity]++;
    halves.set(root, h);
  }
  const fits = (root: string) => {
    const [a, b] = halves.get(root) ?? [0, 0];
    if (root === anchorRoot) return a <= sides.red && b <= sides.yellow;
    return (a <= sides.red && b <= sides.yellow) || (b <= sides.red && a <= sides.yellow);
  };

  // A clash is the whole joined set's: whichever of the clashing groups the
  // search gave up, the reason is the clash.
  const clashRoots = new Set(groups.filter((g) => clashed.has(g.key)).map((g) => uf.find(g.ids[0]).root));
  const out = new Map<string, UnmetReason>();
  for (const g of groups) {
    if (clashed.has(g.key) || clashRoots.has(uf.find(g.ids[0]).root)) out.set(g.key, "clash");
    else if (!fits(uf.find(g.ids[0]).root)) out.set(g.key, "sizes");
    else out.set(g.key, "no-swaps");
  }
  return out;
}

/**
 * The fewest one-for-one swaps between the sides that meet the groups, and
 * of those the one that keeps the ratings closest. Sides keep their sizes;
 * a slot holder who is no longer playing is never swapped, and nor is a
 * player in `fixed` (one the same message placed or moved: review of #619,
 * the change must never undo what it was told). When no change of up to
 * four swaps (bounded by SEARCH_BUDGET) meets every group, the change that
 * breaks the fewest (then the fewest swaps, then the closest ratings) is
 * taken, and when nothing helps nothing moves. Each group still broken
 * carries its true reason (`unmet.why`).
 */
export function planConstraintChange(p: {
  slots: Array<{ userId: string; team: SlotSide; playing: boolean }>;
  together?: string[][];
  apart?: string[][];
  rating: (userId: string) => number;
  /** Players who must not change side. */
  fixed?: Iterable<string>;
}): ConstraintChangePlan {
  const c = { together: cleanGroups(p.together), apart: cleanGroups(p.apart) };
  const team = new Map(p.slots.map((s) => [s.userId, s.team] as [string, SlotSide]));
  const playing = new Set(p.slots.filter((s) => s.playing).map((s) => s.userId));
  const fixed = new Set([...(p.fixed ?? [])].filter((id) => team.has(id)));
  // A slot holder who is no longer playing is not on the teams for this:
  // keeping him apart from anyone means nothing.
  const sideIn = (m: Map<string, SlotSide>) => (id: string) => (playing.has(id) ? m.get(id) : undefined);
  const violations = (m: Map<string, SlotSide>) => {
    const u = unmetConstraints(sideIn(m), c);
    return u.together.length + u.apart.length;
  };
  const gap = (m: Map<string, SlotSide>) => {
    let d = 0;
    for (const [id, t] of m) if (playing.has(id)) d += (t === "RED" ? 1 : -1) * p.rating(id);
    return Math.abs(d);
  };

  const constrained = new Set([...c.together, ...c.apart].flat().filter((id) => playing.has(id) && !fixed.has(id)));
  const movable = [...playing].filter((id) => !fixed.has(id));

  let best = { swaps: [] as Array<[string, string]>, v: violations(team), g: gap(team) };
  if (best.v > 0 && constrained.size > 0) {
    const better = (v: number, n: number, g: number) =>
      v < best.v || (v === best.v && n < best.swaps.length) || (v === best.v && n === best.swaps.length && g < best.g - 1e-9);
    const dfs = (m: Map<string, SlotSide>, swaps: Array<[string, string]>, used: Set<string>, depth: number) => {
      if (swaps.length === depth) {
        const v = violations(m);
        const g = gap(m);
        if (better(v, swaps.length, g)) best = { swaps: [...swaps], v, g };
        return;
      }
      for (const x of constrained) {
        if (used.has(x)) continue;
        for (const y of movable) {
          if (y === x || used.has(y) || m.get(y) === m.get(x)) continue;
          // Each unordered pair once per level: a constrained y only after x.
          if (constrained.has(y) && y < x) continue;
          const tx = m.get(x)!;
          const ty = m.get(y)!;
          m.set(x, ty);
          m.set(y, tx);
          used.add(x);
          used.add(y);
          swaps.push([x, y]);
          dfs(m, swaps, used, depth);
          swaps.pop();
          used.delete(x);
          used.delete(y);
          m.set(x, tx);
          m.set(y, ty);
        }
      }
    };
    // Each level multiplies the work by about (constrained x players); a
    // level that would pass SEARCH_BUDGET is not tried.
    const perLevel = constrained.size * movable.length;
    for (let depth = 1; depth <= MAX_SWAPS && best.v > 0 && perLevel ** depth <= SEARCH_BUDGET; depth++) {
      dfs(new Map(team), [], new Set(), depth);
    }
  }

  const after = new Map(team);
  for (const [x, y] of best.swaps) {
    const tx = after.get(x)!;
    after.set(x, after.get(y)!);
    after.set(y, tx);
  }
  const unmet = unmetConstraints(sideIn(after), c);
  if (unmet.together.length + unmet.apart.length === 0) return { team: after, swaps: best.swaps, unmet };
  const count = (side: SlotSide) => [...playing].filter((id) => team.get(id) === side).length;
  const known = diagnoseExisting(c, new Map([...fixed].filter((id) => playing.has(id)).map((id) => [id, team.get(id)!])), {
    red: count("RED"),
    yellow: count("YELLOW"),
  });
  return { team: after, swaps: best.swaps, unmet: explainUnmet(unmet, sideIn(after), known) };
}

// ── What MatchTime says about them ────────────────────────────────────

const sameGroup = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\u0000") === [...b].sort().join("\u0000");

/**
 * One line per group asked for: met ("Dan and Craig are on different
 * teams.") or not ("I couldn't split Dan and Craig between the teams, ...").
 * Whether a group is met is read from `unmet`, which was read from the
 * teams themselves, so the words always match the sheet.
 */
export function constraintLines(args: {
  together: Array<Array<{ userId: string; name: string }>>;
  apart: Array<Array<{ userId: string; name: string }>>;
  unmet: UnmetConstraints;
  lang?: Lang | string | null;
}): string[] {
  const s = t(args.lang);
  const lines: string[] = [];
  const ids = (g: Array<{ userId: string }>) => g.map((m) => m.userId);
  const names = (g: Array<{ name: string }>) => joinList(args.lang, g.map((m) => m.name));
  /** The true reason, said after the line; nothing when it is not known. */
  const because = (kind: "together" | "apart", g: Array<{ userId: string; name: string }>): string => {
    const why = args.unmet.why?.[groupKey(kind, ids(g))];
    if (!why) return "";
    switch (why.reason) {
      case "not-on-teams": {
        const missing = g.filter((m) => (why.missing ?? []).includes(m.userId));
        return ` ${s.teams_unmet_missing({ names: names(missing), many: missing.length > 1 })}`;
      }
      case "clash":
        return ` ${s.teams_unmet_clash}`;
      case "sizes":
        return ` ${s.teams_unmet_sizes}`;
      case "no-swaps":
        return ` ${s.teams_unmet_no_swaps}`;
    }
  };
  for (const g of args.together) {
    if (g.length < 2) continue;
    const broken = args.unmet.together.some((u) => sameGroup(u, ids(g)));
    lines.push(broken ? `${s.teams_together_unmet({ names: names(g) })}${because("together", g)}` : s.teams_together_met({ names: names(g) }));
  }
  for (const g of args.apart) {
    if (g.length < 2) continue;
    const broken = args.unmet.apart.some((u) => sameGroup(u, ids(g)));
    lines.push(broken ? `${s.teams_apart_unmet({ names: names(g) })}${because("apart", g)}` : s.teams_apart_met({ names: names(g), many: g.length > 2 }));
  }
  return lines;
}

// ── The players' group: "keep Dan and Craig apart" on the teams as they stand ──

export type KeepChangeDecision =
  /** No teams yet: nothing is stored, the asker is told to say it with the build. */
  | { kind: "not-made"; reply: string; logReason: string }
  /** A name nobody can place: nothing written, the reason said. */
  | { kind: "refused"; reply: string; logReason: string }
  /** Nothing to write: every group already holds (`allMet`), or no swap helps. */
  | { kind: "unchanged"; allMet: boolean; reply: string; logReason: string }
  /** Write `changes` (only the players who change side), then post `lead`
   *  and the team sheet under it. */
  | { kind: "change"; changes: Map<string, SlotSide>; lead: string; logReason: string };

type Named = Array<Array<{ userId: string; name: string }>>;

/**
 * PURE. A players'-group change the teams extractor read as `swap` with
 * `apart` and/or `pairings` (2026-11-16): who each name is (who-is-who's
 * pick, "me" the sender, checked against this match's players), then the
 * fewest swaps that meet the groups (`planConstraintChange`), and what to
 * say. Never a rebuild, never an attendance change.
 */
export function decideKeepChange(args: {
  /** As the extractor wrote them: names, "me" for the sender. */
  together: string[][];
  apart: string[][];
  /** Everyone on this match: attendance rows and slot holders. */
  roster: SwapCandidate[];
  sender: { userId: string; name: string } | null;
  people?: PersonPicks;
  rating: (userId: string) => number;
  lang?: Lang | string | null;
}): KeepChangeDecision {
  const s = t(args.lang);
  const slots = args.roster.filter((r) => r.team !== null);
  if (slots.length === 0) {
    return { kind: "not-made", reply: s.teams_keep_not_made, logReason: "keep together/apart: no teams yet; nothing stored" };
  }

  // Who each name is. The extractor writes "me" for the sender.
  const resolve = (ref: string): SideResolution => {
    if (["me", "myself"].includes(ref.trim().toLowerCase())) {
      if (!args.sender) return { kind: "unknown" };
      const own = args.roster.find((c) => c.userId === args.sender!.userId);
      return { kind: "resolved", side: own ?? { userId: args.sender.userId, name: args.sender.name, status: "NONE", team: null } };
    }
    return resolveSwapSideDetailed(ref, args.roster, args.people);
  };
  /** The groups by member, or the first name that cannot be placed, said. */
  const named = (groups: string[][]): { groups: Named } | { problem: string } => {
    const out: Named = [];
    for (const g of groups) {
      const members: Array<{ userId: string; name: string }> = [];
      for (const ref of g) {
        const r = resolve(ref);
        if (r.kind === "unknown") return { problem: s.swap_refused_unknown({ name: typedName(ref) }) };
        if (r.kind === "ambiguous") {
          return { problem: s.swap_refused_ambiguous({ name: typedName(ref), candidates: r.candidates.map((c) => c.name) }) };
        }
        if (!members.some((m) => m.userId === r.side.userId)) members.push({ userId: r.side.userId, name: r.side.name });
      }
      if (members.length >= 2) out.push(members);
    }
    return { groups: out };
  };
  const together = named(args.together);
  const apart = named(args.apart);
  if ("problem" in together || "problem" in apart) {
    const why = "problem" in together ? together.problem : (apart as { problem: string }).problem;
    return { kind: "refused", reply: s.teams_keep_refused({ why }), logReason: `keep together/apart refused: ${why}` };
  }
  const tg = together.groups;
  const ag = apart.groups;
  const ids = (gs: Named) => gs.map((g) => g.map((m) => m.userId));

  const plan = planConstraintChange({
    slots: slots.map((r) => ({ userId: r.userId, team: r.team as SlotSide, playing: r.status === "CONFIRMED" })),
    together: ids(tg),
    apart: ids(ag),
    rating: args.rating,
  });
  const lines = constraintLines({ together: tg, apart: ag, unmet: plan.unmet, lang: args.lang });
  const what = `together ${JSON.stringify(ids(tg))} apart ${JSON.stringify(ids(ag))}`;
  if (plan.swaps.length === 0) {
    const allMet = noneUnmet(plan.unmet);
    return {
      kind: "unchanged",
      allMet,
      // "Nothing needed changing" only when nothing did: a group that could
      // not be met says so in its own line instead.
      reply: [...lines, ...(allMet ? [s.teams_keep_nothing_to_change] : [])].join("\n"),
      logReason: `keep ${what}: nothing written (${plan.unmet.together.length + plan.unmet.apart.length} group(s) not met)`,
    };
  }
  const nameOf = new Map(args.roster.map((r) => [r.userId, r.name]));
  const before = new Map(slots.map((r) => [r.userId, r.team as SlotSide]));
  const changes = new Map([...plan.team].filter(([id, side]) => before.get(id) !== side));
  const pairs = joinList(
    args.lang,
    plan.swaps.map(([a, b]) => s.teams_keep_pair({ a: nameOf.get(a) ?? "?", b: nameOf.get(b) ?? "?" })),
  );
  return {
    kind: "change",
    changes,
    lead: `${s.teams_keep_swapped({ pairs })}\n${lines.join("\n")}\n\n${s.teams_keep_updated}`,
    logReason: `keep ${what}: ${plan.swaps.map(([a, b]) => `${a}<->${b}`).join(", ")}`,
  };
}

const typedName = (w: string) => {
  const x = w.trim();
  return x ? x.charAt(0).toUpperCase() + x.slice(1) : x;
};
