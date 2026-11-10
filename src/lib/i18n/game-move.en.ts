/** Moving a game by WhatsApp, in English. See `game-move.ts`. */
import type { GameMoveCopy, GameStayReason } from "./game-move";

const QUIET = "I haven't posted anything in the players' group.";
const EXAMPLE = "*@Match Time move Monday's game to 20:15*";

/** A short reason, for the weekly list. */
const short: Record<GameStayReason, string> = {
  started: "already kicked off",
  "set-by-hand": "set to its own time by hand",
  "into-the-past": "the new time has already gone",
  "other-month": "it would move into another month",
  "unreadable-time": "its time couldn't be read",
  unchanged: "already at that time",
  gone: "no longer to be played",
};

const orList = (items: string[]): string =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}` : items.join("");

export const GAME_MOVE_EN: GameMoveCopy = {
  movedOne: (p) =>
    (p.toDay
      ? `✅ Done: the game on ${p.day} is now on ${p.toDay} at ${p.time}.`
      : `✅ Done: the game on ${p.day} is now at ${p.time} (it was ${p.was}).`) + `\n${QUIET}`,
  stayedOne: (p) => {
    switch (p.reason) {
      case "started":
        return `The game on ${p.day} has already kicked off, so I've left it as it is.`;
      case "into-the-past":
        return `${p.to} has already gone, so I've left the game on ${p.day} at ${p.time}.`;
      case "other-month":
        return `That would move the game on ${p.day} into another month, so I've left it as it is.`;
      case "unchanged":
        return `The game on ${p.day} is already at ${p.time}.`;
      default:
        return `I couldn't move the game on ${p.day}. It may have been played or called off.`;
    }
  },
  movedWeekly: (p) => {
    const lines = [`✅ Done: *${p.name}* kicks off at ${p.time} every ${p.weekday} from now on.`];
    if (p.moved.length > 0) lines.push(`Moved: ${p.moved.join(", ")}.`);
    if (p.stayed.length > 0) lines.push(`Left as they were: ${p.stayed.map((s) => `${s.day} (${short[s.reason]})`).join(", ")}.`);
    lines.push(QUIET);
    return lines.join("\n");
  },
  weeklyUnchanged: (p) => `*${p.name}* already kicks off at ${p.time} every ${p.weekday}.`,
  which: (p) => `Which game shall I move to ${p.change}: ${orList(p.options)}? Tag me again and name the day, for example ${EXAMPLE}.`,
  whichWeekly: (p) =>
    `Which weekly game moves to ${p.change} from now on: ${orList(p.options.map((o) => `*${o}*`))}? Tag me again and name it.`,
  sayWhat: `What should I move it to? Tag me with the new time or day, for example ${EXAMPLE}.`,
  noGames: "There's no game coming up to move.",
  invalid: `I couldn't use that time. Tag me with a time like 20:15, for example ${EXAMPLE}.`,
};
