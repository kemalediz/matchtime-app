/** Man of the Match on the web pages, in English. See `mom-web.ts`. */
import type { MomWebCopy } from "./mom-web";

export const MOM_WEB_EN: MomWebCopy = {
  open: "Voting open",
  closedToBePosted: "Voting closed, the result will be posted in the group",
  closedPlain: "Voting closed",
  posted: "Result posted in the group",
  pickedToBePosted: "Picked by the organisers, to be posted in the group",
  shared: (p) => `Shared between ${p.names}`,
  votesOf: (p) => `(${p.top} of ${p.total} vote${p.total === 1 ? "" : "s"})`,
  votesEach: (p) => `(${p.top} vote${p.top === 1 ? "" : "s"} each)`,
  picked: "(picked by the organisers)",
  alsoReceived: "Also received votes:",
  and: " and ",
  wins: (n) => `${n} MoM win${n === 1 ? "" : "s"}`,
  winsNote: "MoM wins count decided results only: a vote still open, or still to be posted, counts once it is final.",
};
