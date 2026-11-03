/** A game's sizes, in English. See `flex-format.ts`. */
import type { FlexFormatCopy } from "./flex-format";

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
const names = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const side = (n: number): string => `${n}-a-side`;
const sides = (ns: number[]): string => `${list(ns.map(String))} a side`;
const range = (min: number, max: number): string => (min === max ? `${min}` : `${min} to ${max}`);

export const FLEX_FORMAT_EN: FlexFormatCopy = {
  side,
  sides,

  // No "<n> players" beside "bench" here: in the players' group the reply
  // guard (`contradictsSquadState`) reads that as a squad total above the
  // places and replaces the whole reply with the squad post.
  rangeSet: (p) =>
    `✅ Done. *${p.activityName}* is played ${sides(p.sides)} now (${range(p.min, p.max)}). ` +
    `I'll only warn you about low numbers below ${p.min}` +
    (p.up ? `, and when two are waiting I'll suggest going up a size.` : `.`) +
    ` Any organiser can switch one game's size by tagging me, for example *@Match Time make it ${p.up ? p.sides[p.sides.length - 1] : p.sides[0]} a side*.`,
  rangeCleared: (p) =>
    `✅ Done. *${p.activityName}* is ${side(p.perSide)} only again: two full sides of ${p.places}, and I'll warn you when fewer than ${p.places} are in.`,
  rangeUnchanged: (p) => `*${p.activityName}* is already played ${sides(p.sides)} (${range(p.min, p.max)}).`,
  rangeRefused: (p) => {
    switch (p.error) {
      case "odd":
        return `Players have to be an even number, so both sides are the same size: for example 12 or 14.`;
      case "too-low":
        return `The minimum has to be at least 2 players.`;
      case "too-high":
        return `The maximum can be ${p.ceiling} players at most.`;
      case "min-above-places":
        return `*${p.activityName}* has ${p.places} places, so the minimum can be ${p.places} at most.`;
      case "max-below-places":
        return `*${p.activityName}* has ${p.places} places, so the maximum has to be at least ${p.places}.`;
      default:
        return `I couldn't read the numbers. Tag me like this: *@Match Time we play with 12 to 16*, or set them here: ${p.url}`;
    }
  },
  noNumbers: (p) => `I couldn't read the numbers. Tag me like this: *@Match Time we play with 12 to 16*, or set them here: ${p.url}`,
  whichGame: (p) =>
    `Which game do you mean: ${p.names.join(", ")}? Tag me with the day, for example *@Match Time we play with 12 to 16 on Monday*, or set it here: ${p.url}`,
  noGame: (p) => `There's no weekly game set up yet. Add one here: ${p.url}`,

  minLabel: "Minimum players",
  maxLabel: "Maximum players",
  minHint: (p) =>
    `The fewest you'll play with, an even number. Below this I warn you the day before and offer to cancel. Leave it empty for two full sides (${p.full}).`,
  maxHint: (p) =>
    `The most you'll play with, an even number. Organisers can then make one game bigger, and I suggest it when two are on the bench. Leave it empty for ${p.full} only.`,
  allows: (p) => (p.sides.length <= 1 ? `With ${p.min} players you play ${sides(p.sides)}.` : `With ${p.min} to ${p.max} players you can play ${sides(p.sides)}.`),
  row: (p) => sides(p.sides),

  switched: (p) =>
    `✅ Done: ${p.day} is ${side(p.perSide)} now, ${p.places} places.` +
    (p.promoted.length ? ` In from the bench: ${names(p.promoted)}.` : ``) +
    (p.demoted.length ? ` On the bench now: ${names(p.demoted)}.` : ``) +
    (p.teamsCleared ? ` The teams are cleared, so tag me to make them again.` : ``) +
    (p.pickOpen ? ` ${p.pickOpen === 1 ? "1 place is" : `${p.pickOpen} places are`} open, so I'll ask you who comes in from the bench.` : ``),
  activitySwitched: (p) => `✅ Done: ${p.day} is ${side(p.perSide)} now, ${p.places} places. I've posted the new list.`,
  suggestionStale: (p) => `The numbers have changed since I asked, so ${p.day} stays as it is. Tag me if you still want ${side(p.perSide)}.`,
  rangeBlocked: (p) =>
    `${p.day}'s game is ${side(p.perSide)} now, so those numbers would leave it out. Switch it back first, for example *@Match Time make it ${p.backTo} a side*, then change them.`,
  alreadyThat: (p) => `${p.day} is already ${side(p.perSide)}.`,
  notAllowed: (p) =>
    `*${p.activityName}* is played ${sides(p.sides)}, so I can't make it ${side(p.perSide)}. You can change the fewest and most players here: ${p.url}`,
  noRange: (p) =>
    `*${p.activityName}* is only ${side(p.perSide)}. To play other sizes, set the fewest and most players, for example *@Match Time we play with 12 to 16*, or here: ${p.url}`,
  noSize: `How many a side? For example *@Match Time make it 8 a side*.`,
  noMatch: `There's no game coming up to change.`,
  tooLate: `That game has already started, so its size stays as it is.`,

  suggestUp: (p) =>
    `We've got ${p.total} for ${p.day}, ${p.bench} on the bench. Shall we go ${side(p.perSide)}? ` +
    `${p.admins}, reply *yes* to this message and I'll switch it.`,

  dmIn: (p) =>
    `We're going ${side(p.perSide)} on ${p.day}, you're in. Can't make it after all? Reply OUT.` +
    (p.price ? ` You pay as you go for this game, ${p.price}.` : ``),
  dmBench: (p) =>
    `We're going ${side(p.perSide)} on ${p.day}, so the squad is down to ${p.places} and you're on the bench for now.`,

  rosterHeader: (p) => `🔁 *${p.day} is ${side(p.perSide)} now* (${p.places} places).`,
  rosterPlaying: (p) => `*Playing, ${p.confirmed} of ${p.places}:*`,
  rosterBench: `*Bench:*`,
  rosterNobody: `Nobody yet.`,

  pageSizesLabel: "Players a side",
  pageSizeButton: (p) => `${side(p.perSide)} (${p.places})`,
  pageCurrent: (p) => `Now ${side(p.perSide)}, ${p.confirmed} of ${p.places} in.`,
  pageWillPromote: (p) => (p.count === 1 ? `1 player moves in from the bench and gets a DM.` : `${p.count} players move in from the bench and get a DM.`),
  pageWillBench: (p) => (p.count === 1 ? `1 player goes to the bench and gets a DM.` : `${p.count} players go to the bench and get a DM.`),
  pageConfirm: "Switch size",
  pageDone: "Switched. MatchTime posts the new list in the group.",
  pageInvalid: "Enter an even whole number, or leave it empty.",
};
