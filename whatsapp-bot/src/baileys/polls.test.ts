/**
 * Poll votes under Baileys (plan §2.12), decrypted by us.
 *
 * rc14 carries the vote decryption in `lib/Utils/process-message.js`
 * COMMENTED OUT, so no `pollUpdates` ever arrive on `messages.update`.
 * The vote comes in as an ordinary `messages.upsert` holding an encrypted
 * `pollUpdateMessage`, and decrypting it is ours to do, against the poll
 * WE sent (its `messageSecret`).
 *
 * Every vote in these tests is encrypted with the exact inverse of
 * Baileys' own `decryptPollVote` (HMAC key derivation, AES-256-GCM, the
 * `${pollId}\0${voter}` AAD), so a wrong JID or a wrong secret fails the
 * GCM tag for real rather than by a fake's say-so.
 */
import { describe, it, expect } from "vitest";
import {
  aesEncryptGCM,
  generateWAMessageContent,
  hmacSign,
  proto,
  sha256,
  type WAMessage,
} from "baileys";
import { randomBytes } from "node:crypto";
import { pollContent } from "./outbound.js";
import {
  decodePollMessage,
  encodePollMessage,
  mapPollVote,
  pollOptionNames,
  type PollVoteDeps,
} from "./polls.js";

const GROUP = "120363000000000000@g.us";
const ME_PN = "447700900001@s.whatsapp.net";
const ME_LID = "158000000000001@lid";
const VOTER_PN = "447700900123@s.whatsapp.net";
const VOTER_LID = "158055467598020@lid";
const POLL_ID = "3EB0POLL0001";

async function pollMessage(options = ["Sam", "Alex", "Jo"]): Promise<proto.IMessage> {
  return (await generateWAMessageContent(pollContent("Man of the Match?", options, false) as never, {
    upload: async () => {
      throw new Error("no upload");
    },
  } as never)) as proto.IMessage;
}

function encryptVote(opts: {
  secret: Uint8Array;
  creator: string;
  voter: string;
  pollId?: string;
  options: string[];
}): { encPayload: Uint8Array; encIv: Uint8Array } {
  const pollId = opts.pollId ?? POLL_ID;
  const sign = Buffer.concat([
    Buffer.from(pollId),
    Buffer.from(opts.creator),
    Buffer.from(opts.voter),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(opts.secret, new Uint8Array(32), "sha256");
  const key = hmacSign(sign, key0, "sha256");
  const iv = randomBytes(12);
  const plain = proto.Message.PollVoteMessage.encode({
    selectedOptions: opts.options.map((o) => sha256(Buffer.from(o))),
  }).finish();
  return { encPayload: aesEncryptGCM(plain, key, iv, Buffer.from(`${pollId}\u0000${opts.voter}`)), encIv: iv };
}

/** A vote as it reaches messages.upsert, after Baileys' cleanMessage. */
function voteMessage(
  vote: { encPayload: Uint8Array; encIv: Uint8Array },
  key: Partial<proto.IMessageKey> = {},
): WAMessage {
  return {
    key: {
      remoteJid: GROUP,
      fromMe: false,
      id: "3EB0VOTE0001",
      participant: VOTER_LID,
      participantAlt: VOTER_PN,
      ...key,
    },
    message: proto.Message.fromObject({
      pollUpdateMessage: {
        pollCreationMessageKey: { remoteJid: GROUP, fromMe: true, id: POLL_ID, participant: VOTER_LID },
        vote,
        senderTimestampMs: 1758100000000,
      },
    }),
    messageTimestamp: 1758100000,
    pushName: "Sam",
  } as WAMessage;
}

async function deps(overrides: Partial<PollVoteDeps> = {}) {
  const poll = await pollMessage();
  const base: PollVoteDeps = {
    pollMessage: (id) => (id === POLL_ID ? poll : undefined),
    self: () => ({ pn: ME_PN, lid: ME_LID }),
    ownJidFor: () => "447700900001@s.whatsapp.net",
    phoneForLid: async () => null,
  };
  return { poll, secret: poll.messageContextInfo!.messageSecret as Uint8Array, deps: { ...base, ...overrides } };
}

describe("mapPollVote", () => {
  it("ignores a message that is not a vote", async () => {
    const { deps: d } = await deps();
    const m = { key: { remoteJid: GROUP, id: "X" }, message: proto.Message.fromObject({ conversation: "IN" }) } as WAMessage;
    expect(await mapPollVote(m, d)).toEqual({ kind: "not-a-vote" });
  });

  it("decrypts a vote signed with PN identities (what Baileys' own event-response code uses)", async () => {
    const { secret, deps: d } = await deps();
    const m = voteMessage(encryptVote({ secret, creator: ME_PN, voter: VOTER_PN, options: ["Alex"] }));
    const out = await mapPollVote(m, d);
    expect(out).toMatchObject({
      kind: "forward",
      payload: {
        parentMessage: { id: { _serialized: `true_${GROUP}_${POLL_ID}_447700900001@c.us` } },
        voter: "447700900123@c.us",
        selectedOptions: [{ name: "Alex", localId: 1 }],
      },
    });
  });

  it("decrypts a vote signed with LID identities too: which one a LID group uses is unverified", async () => {
    const { secret, deps: d } = await deps();
    const m = voteMessage(encryptVote({ secret, creator: ME_LID, voter: VOTER_LID, options: ["Jo"] }));
    const out = await mapPollVote(m, d);
    expect(out.kind).toBe("forward");
    if (out.kind === "forward") {
      expect(out.payload.selectedOptions).toEqual([{ name: "Jo", localId: 2 }]);
      expect(out.via).toEqual({ creator: ME_LID, voter: VOTER_LID });
    }
  });

  it("hands up the voter as a LID only when no phone is known anywhere", async () => {
    const { secret, deps: d } = await deps();
    const m = voteMessage(encryptVote({ secret, creator: ME_LID, voter: VOTER_LID, options: ["Sam"] }), {
      participantAlt: null,
    });
    const out = await mapPollVote(m, d);
    expect(out.kind === "forward" && out.payload.voter).toBe("158055467598020@lid");
    const known = await mapPollVote(m, { ...d, phoneForLid: async () => "447700900123" });
    expect(known.kind === "forward" && known.payload.voter).toBe("447700900123@c.us");
  });

  it("forwards an un-vote (no options) with an empty selection, as whatsapp-web.js did", async () => {
    const { secret, deps: d } = await deps();
    const m = voteMessage(encryptVote({ secret, creator: ME_PN, voter: VOTER_PN, options: [] }));
    const out = await mapPollVote(m, d);
    expect(out.kind === "forward" && out.payload.selectedOptions).toEqual([]);
  });

  it("puts OUR id on the parent in a LID-addressed group, matching the stored send id", async () => {
    const { secret, deps: d } = await deps({ ownJidFor: () => ME_LID });
    const m = voteMessage(encryptVote({ secret, creator: ME_PN, voter: VOTER_PN, options: ["Sam"] }));
    const out = await mapPollVote(m, d);
    expect(out.kind === "forward" && out.payload.parentMessage?.id?._serialized).toBe(
      `true_${GROUP}_${POLL_ID}_${ME_LID}`,
    );
  });

  it("reports a poll we do not hold (sent before the cutover, or never ours) as undecryptable", async () => {
    const { secret, deps: d } = await deps({ pollMessage: () => undefined });
    const m = voteMessage(encryptVote({ secret, creator: ME_PN, voter: VOTER_PN, options: ["Sam"] }));
    expect(await mapPollVote(m, d)).toMatchObject({ kind: "undecryptable", pollId: POLL_ID });
  });

  it("reports a vote that no identity pair decrypts as undecryptable, never as a guess", async () => {
    const { deps: d } = await deps();
    const m = voteMessage(
      encryptVote({ secret: randomBytes(32), creator: ME_PN, voter: VOTER_PN, options: ["Sam"] }),
    );
    const out = await mapPollVote(m, d);
    expect(out).toMatchObject({ kind: "undecryptable" });
    expect(out.kind === "undecryptable" && out.reason).toMatch(/no identity pair/);
  });

  it("ignores our own vote from another of our devices", async () => {
    const { secret, deps: d } = await deps();
    const m = voteMessage(encryptVote({ secret, creator: ME_PN, voter: ME_PN, options: ["Sam"] }), {
      fromMe: true,
    });
    expect(await mapPollVote(m, d)).toEqual({ kind: "own" });
  });
});

describe("pollOptionNames and the poll codec", () => {
  it("reads the options off whichever creation message version Baileys built", async () => {
    expect(pollOptionNames(await pollMessage(["A", "B"]))).toEqual(["A", "B"]);
    expect(pollOptionNames(proto.Message.fromObject({ conversation: "x" }))).toEqual([]);
  });

  it("round-trips a poll, secret included, so it survives a restart on disk", async () => {
    const poll = await pollMessage();
    const back = decodePollMessage(encodePollMessage(poll));
    expect(back && Buffer.from(back.messageContextInfo!.messageSecret!)).toEqual(
      Buffer.from(poll.messageContextInfo!.messageSecret!),
    );
    expect(back && pollOptionNames(back)).toEqual(["Sam", "Alex", "Jo"]);
    expect(decodePollMessage("not base64 protobuf !!")).toBeNull();
  });
});
