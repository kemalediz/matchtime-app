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
vi.mock("@/lib/db", () => ({
  db: {
    sentNotification: { findFirst: (...a: unknown[]) => sentFindFirst(...a) },
    botJob: { findUnique: (...a: unknown[]) => jobFindUnique(...a) },
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
const PROMPT: FeeConfirmPrompt = { botJobId: "job-1", matchId: "m1", orgId: "org", phone: "447525334985" };

function deps(over: Partial<FeeConfirmReactionDeps> = {}) {
  const d = {
    prompt: vi.fn(async () => PROMPT),
    latestPromptId: vi.fn(async () => "job-1"),
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
    expect(d.confirm).toHaveBeenCalledWith("kemal", "m1");
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
    const d = deps({ latestPromptId: vi.fn(async () => "job-2") });
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

  it("is null for a DM that is not a BotJob dispatch (a scheduler DM)", async () => {
    sentFindFirst.mockResolvedValue({ key: "m1:fee-ask:kemal" });
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
