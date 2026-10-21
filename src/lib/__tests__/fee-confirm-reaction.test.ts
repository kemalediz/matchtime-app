/**
 * A ✅ or 👍 REACTION on the collector's fee confirm prompt counts as his
 * "yes" (Sutton FC, 2026-10-21: Kemal reacted ✅, nothing happened, the
 * players never got their pay links).
 *
 * The decision is `runFeeConfirmReaction`, a pure function of its deps.
 * The join is on the prompt's stored message id, never on its words:
 *   reaction.waMessageId
 *     → SentNotification{kind:"dm", waMessageId}  (stamped by /ack)
 *     → key `botjob-<id>`
 *     → BotJob{id, aboutKey:"<matchId>:fee-confirm"}  (queued by dm-reply)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sentFindFirst = vi.fn();
const jobFindUnique = vi.fn();
const userFindUnique = vi.fn();
const matchFindUnique = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    sentNotification: { findFirst: (...a: unknown[]) => sentFindFirst(...a) },
    botJob: { findUnique: (...a: unknown[]) => jobFindUnique(...a) },
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) },
  },
}));

import {
  feeConfirmAboutKey,
  isFeeConfirmYesEmoji,
  resolveFeeConfirmPrompt,
  runFeeConfirmReaction,
  type FeeConfirmPrompt,
  type FeeConfirmReactionDeps,
} from "@/lib/fee-confirm-reaction";

const WA = "true_447525334985@c.us_3EB01CA3A67CC8AC4CE8FD";
const PROMPT: FeeConfirmPrompt = {
  ref: "botjob-job-1",
  askKey: "m1:fee-confirm",
  matchId: "m1",
  orgId: "org",
  phone: "447525334985",
  recipientUserId: null,
};
/** The monthly PAYG fee question the scheduler sent (not a BotJob). */
const ASK: FeeConfirmPrompt = {
  ref: "m1:fee-ask",
  askKey: "m1:fee-ask",
  matchId: "m1",
  orgId: "org",
  phone: "447525334985",
  recipientUserId: "kemal",
};

function deps(over: Partial<FeeConfirmReactionDeps> = {}) {
  const d = {
    prompt: vi.fn(async (): Promise<FeeConfirmPrompt | null> => PROMPT),
    latestPromptRef: vi.fn(async () => "botjob-job-1"),
    collector: vi.fn(async () => ({ userId: "kemal", phone: "+447525334985" })),
    confirm: vi.fn(async () => ({ matchId: "m1", orgId: "org", released: 13, reply: "ack" })),
    queueAck: vi.fn(async () => {}),
    ...over,
  };
  return d;
}

describe("isFeeConfirmYesEmoji", () => {
  it("accepts ✅ and 👍 in every skin tone", () => {
    for (const e of ["✅", "👍", "👍🏻", "👍🏼", "👍🏽", "👍🏾", "👍🏿", " ✅ "]) expect(isFeeConfirmYesEmoji(e)).toBe(true);
  });
  it("refuses everything else", () => {
    for (const e of ["❤️", "😂", "👎", "❌", "🙏", "", "✅✅"]) expect(isFeeConfirmYesEmoji(e)).toBe(false);
  });
});

describe("runFeeConfirmReaction", () => {
  it("is null for a reaction that is not on a fee confirm prompt, so the route falls through", async () => {
    const d = deps({ prompt: vi.fn(async () => null) });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toBeNull();
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("✅ from the collector on the latest prompt confirms and queues the ack once", async () => {
    const d = deps();
    const res = await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d);
    expect(res).toMatchObject({ ok: true, handled: "fee-confirm-reaction", released: 13, matchId: "m1" });
    expect(d.confirm).toHaveBeenCalledWith("kemal", "m1", "m1:fee-confirm");
    expect(d.queueAck).toHaveBeenCalledTimes(1);
    expect(d.queueAck).toHaveBeenCalledWith({ orgId: "org", phone: "447525334985", text: "ack", matchId: "m1" });
  });

  it("👍 counts the same", async () => {
    const d = deps();
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "👍🏽", fromPhone: "447525334985" }, d)).toMatchObject({
      handled: "fee-confirm-reaction",
    });
  });

  it("an @lid reactor (no readable phone) in the collector's 1-1 chat counts: only he can react there", async () => {
    const d = deps();
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "" }, d)).toMatchObject({
      handled: "fee-confirm-reaction",
    });
  });

  it("any other emoji does nothing", async () => {
    const d = deps();
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "❤️", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "not-yes",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("a reactor who is not the person DMed does nothing", async () => {
    const d = deps();
    const res = await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447700900001" }, d);
    expect(res).toEqual({ ok: true, ignored: "reactor-not-the-recipient" });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("a prompt that went to somebody who is no longer the club's collector does nothing", async () => {
    const d = deps({ collector: vi.fn(async () => ({ userId: "other", phone: "+447700900002" })) });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "not-the-collector",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("no collector (payment collection off) does nothing", async () => {
    const d = deps({ collector: vi.fn(async () => null) });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "not-the-collector",
    });
  });

  it("a superseded prompt (a newer amount was asked since) does nothing", async () => {
    const d = deps({ latestPromptRef: vi.fn(async () => "botjob-job-2") });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "superseded-prompt",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("nothing pending or already released: no ack, nothing sent", async () => {
    const d = deps({ confirm: vi.fn(async () => null) });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "nothing-pending",
    });
    expect(d.queueAck).not.toHaveBeenCalled();
  });
});

describe("runFeeConfirmReaction on the monthly PAYG fee question (a scheduler DM)", () => {
  const askDeps = (over: Partial<FeeConfirmReactionDeps> = {}) =>
    deps({ prompt: vi.fn(async () => ASK), latestPromptRef: vi.fn(async () => "m1:fee-ask"), ...over });

  it("✅ from the collector confirms through the typed yes's path, with the question's own key", async () => {
    const d = askDeps();
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toMatchObject({
      handled: "fee-confirm-reaction",
      released: 13,
    });
    expect(d.confirm).toHaveBeenCalledWith("kemal", "m1", "m1:fee-ask");
    expect(d.queueAck).toHaveBeenCalledWith({ orgId: "org", phone: "447525334985", text: "ack", matchId: "m1" });
  });

  it("the question went to another user than today's collector (same phone or not): nothing", async () => {
    const d = askDeps({ collector: vi.fn(async () => ({ userId: "someone-else", phone: "+447525334985" })) });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "not-the-collector",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("superseded by a later confirm prompt (he typed an amount since): nothing", async () => {
    const d = askDeps({ latestPromptRef: vi.fn(async () => "botjob-job-9") });
    expect(await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447525334985" }, d)).toEqual({
      ok: true,
      ignored: "superseded-prompt",
    });
    expect(d.confirm).not.toHaveBeenCalled();
  });

  it("the first ask when its re-ask is the one that went out: nothing", async () => {
    const d = askDeps({ latestPromptRef: vi.fn(async () => "m1:fee-ask:again") });
    expect((await runFeeConfirmReaction({ waMessageId: WA, emoji: "👍", fromPhone: "447525334985" }, d))?.ignored).toBe(
      "superseded-prompt",
    );
  });

  it("a reactor who is not the recipient, and any other emoji: nothing", async () => {
    const d = askDeps();
    expect((await runFeeConfirmReaction({ waMessageId: WA, emoji: "✅", fromPhone: "447700900001" }, d))?.ignored).toBe(
      "reactor-not-the-recipient",
    );
    expect((await runFeeConfirmReaction({ waMessageId: WA, emoji: "🙏", fromPhone: "447525334985" }, d))?.ignored).toBe("not-yes");
    expect(d.confirm).not.toHaveBeenCalled();
  });
});

describe("resolveFeeConfirmPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sentFindFirst.mockResolvedValue({ key: "botjob-job-1" });
    jobFindUnique.mockResolvedValue({
      id: "job-1",
      kind: "dm",
      orgId: "org",
      phone: "447525334985",
      matchId: "m1",
      aboutKey: feeConfirmAboutKey("m1"),
    });
  });

  it("joins the reaction to the prompt by the stored message id", async () => {
    expect(await resolveFeeConfirmPrompt(WA)).toEqual(PROMPT);
    expect(sentFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ waMessageId: WA, kind: "dm" }) }),
    );
    expect(jobFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "job-1" } }));
  });

  it("is null for a scheduler DM that is not a fee question (a rating DM, a pay chase)", async () => {
    for (const key of ["m1:fee-ask:kemal", "m1:fee-ask:declined", "m1:rating-dm:kemal", "m1:pay-chase:ali:2026-10-21"]) {
      sentFindFirst.mockResolvedValue({ key, matchId: "m1", targetUser: "kemal" });
      expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
    }
  });

  it("joins the monthly PAYG fee question (`<matchId>:fee-ask`) by its claim row's own match and recipient", async () => {
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask", matchId: "m1", targetUser: "kemal" });
    userFindUnique.mockResolvedValue({ phoneNumber: "+447525334985" });
    matchFindUnique.mockResolvedValue({ activity: { orgId: "org" } });
    expect(await resolveFeeConfirmPrompt(WA)).toEqual(ASK);
    expect(userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "kemal" } }));
    expect(jobFindUnique).not.toHaveBeenCalled();
  });

  it("joins its one re-ask (`:fee-ask:again`) the same way", async () => {
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask:again", matchId: "m1", targetUser: "kemal" });
    userFindUnique.mockResolvedValue({ phoneNumber: "+447525334985" });
    matchFindUnique.mockResolvedValue({ activity: { orgId: "org" } });
    expect(await resolveFeeConfirmPrompt(WA)).toEqual({ ...ASK, ref: "m1:fee-ask:again", askKey: "m1:fee-ask:again" });
  });

  it("a fee question row with no recipient, another match, or a recipient with no phone: null", async () => {
    userFindUnique.mockResolvedValue({ phoneNumber: "+447525334985" });
    matchFindUnique.mockResolvedValue({ activity: { orgId: "org" } });
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask", matchId: "m1", targetUser: null });
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask", matchId: "m2", targetUser: "kemal" });
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask", matchId: "m1", targetUser: "kemal" });
    userFindUnique.mockResolvedValue({ phoneNumber: null });
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
  });

  it("is null for any other BotJob DM (the released ack, a Q&A answer)", async () => {
    jobFindUnique.mockResolvedValue({ id: "job-1", kind: "dm", orgId: "org", phone: "447525334985", matchId: "m1", aboutKey: null });
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
  });

  it("is null when the aboutKey names another match than the job", async () => {
    jobFindUnique.mockResolvedValue({
      id: "job-1",
      kind: "dm",
      orgId: "org",
      phone: "447525334985",
      matchId: "m2",
      aboutKey: feeConfirmAboutKey("m1"),
    });
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
  });

  it("is null when nothing carries the id, and never throws", async () => {
    sentFindFirst.mockResolvedValue(null);
    expect(await resolveFeeConfirmPrompt(WA)).toBeNull();
    sentFindFirst.mockRejectedValue(new Error("db down"));
    await expect(resolveFeeConfirmPrompt(WA)).resolves.toBeNull();
  });
});
