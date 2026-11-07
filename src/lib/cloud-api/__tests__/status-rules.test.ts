/**
 * META'S STATUS UPDATES ON A CLOUD JOB (WhatsApp Cloud API plan, PR C5,
 * sections 5.2 and 5.5). Pure. Meta sends sent, delivered, read and failed,
 * repeats them for up to 7 days and may send them out of order, so every
 * rule is idempotent: the same status twice changes nothing the second
 * time. A job the dispatcher left `unconfirmed` (or still `claimed`) is
 * settled by the first status that says what happened.
 *
 * Every write carries its GUARD (review of #554, item 5): the columns it
 * writes must still be empty when it lands, and a failed write needs
 * delivered and read still empty, so two statuses racing can never end
 * with failed plus deliveredAt, or one overwriting the other's time.
 */
import { describe, expect, it } from "vitest";
import type { CloudStatusUpdate } from "../inbound";
import { cloudStatusUpdate, type StatusJobView } from "../status-rules";

const NOW = new Date("2026-11-07T12:00:00Z");
const AT = new Date("2026-11-07T11:59:00Z");
const SENT_AT = new Date("2026-11-07T11:58:00Z");

function job(over: Partial<StatusJobView> = {}): StatusJobView {
  return { id: "j1", status: "sent", channel: "cloud", purpose: "pool-offer", createdAt: SENT_AT, waMessageId: "wamid.A", sentAt: SENT_AT, deliveredAt: null, readAt: null, ...over };
}
function st(status: string, over: Partial<CloudStatusUpdate> = {}): CloudStatusUpdate {
  return { wamid: "wamid.A", phoneNumberId: "1", status, at: AT, recipient: "447700900001", recipientUserId: null, jobId: "j1", errorCode: null, errorTitle: null, pricing: null, ...over };
}

describe("cloudStatusUpdate: a job the dispatcher recorded as sent", () => {
  it("sent again changes nothing", () => {
    expect(cloudStatusUpdate(job(), st("sent"), NOW)).toBeNull();
  });

  it("delivered stamps deliveredAt with Meta's time, once, only while it is still empty", () => {
    expect(cloudStatusUpdate(job(), st("delivered"), NOW)).toEqual({ data: { deliveredAt: AT }, guard: { deliveredAt: null }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: AT }), st("delivered"), NOW)).toBeNull();
  });

  it("read stamps readAt, and deliveredAt too when delivered never came, each only while empty", () => {
    expect(cloudStatusUpdate(job(), st("read"), NOW)).toEqual({ data: { deliveredAt: AT, readAt: AT }, guard: { deliveredAt: null, readAt: null }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: SENT_AT }), st("read"), NOW)).toEqual({ data: { readAt: AT }, guard: { readAt: null }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: SENT_AT, readAt: AT }), st("read"), NOW)).toBeNull();
  });

  it("failed marks it failed with Meta's code and title, only while delivered and read are still empty", () => {
    expect(cloudStatusUpdate(job(), st("failed", { errorCode: 131026, errorTitle: "Message undeliverable" }), NOW)).toEqual({
      data: { status: "failed", failedAt: AT, errorCode: 131026, failReason: "Meta status failed: 131026 Message undeliverable" },
      guard: { deliveredAt: null, readAt: null },
      settles: "failed",
    });
  });

  it("failed after delivered or read is ignored: it reached him", () => {
    expect(cloudStatusUpdate(job({ deliveredAt: AT }), st("failed", { errorCode: 131026 }), NOW)).toBeNull();
    expect(cloudStatusUpdate(job({ readAt: AT }), st("failed", { errorCode: 131026 }), NOW)).toBeNull();
  });

  it("Meta's time missing: now", () => {
    expect(cloudStatusUpdate(job(), st("delivered", { at: null }), NOW)?.data).toEqual({ deliveredAt: NOW });
  });

  it("a status Meta adds later, or an empty one, changes nothing", () => {
    expect(cloudStatusUpdate(job(), st("deleted"), NOW)).toBeNull();
  });
});

describe("cloudStatusUpdate: settling an unconfirmed or still claimed job", () => {
  it("unconfirmed (the send timed out) + sent: sent, with the wamid Meta names, only while it has none", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("sent"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A" },
      guard: { waMessageId: null },
      settles: "sent",
    });
  });

  it("unconfirmed + delivered: sent and delivered at once", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("delivered"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A", deliveredAt: AT },
      guard: { waMessageId: null, deliveredAt: null },
      settles: "sent",
    });
  });

  it("claimed (the status beat the dispatcher's own write): sent, with Meta's time as sentAt", () => {
    expect(cloudStatusUpdate(job({ status: "claimed", waMessageId: null, sentAt: null }), st("sent"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A", sentAt: AT },
      guard: { waMessageId: null, sentAt: null },
      settles: "sent",
    });
  });

  it("unconfirmed + failed: failed, with the wamid kept", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("failed", { errorCode: 131049, errorTitle: null }), NOW)).toEqual({
      data: { status: "failed", failedAt: AT, errorCode: 131049, failReason: "Meta status failed: 131049", waMessageId: "wamid.A" },
      guard: { deliveredAt: null, readAt: null, waMessageId: null },
      settles: "failed",
    });
  });

  it("failed with no error at all says so", () => {
    expect(cloudStatusUpdate(job(), st("failed"), NOW)?.data).toMatchObject({ errorCode: null, failReason: "Meta status failed: no code" });
  });

  it("a very long title is cut to the column's 500", () => {
    const out = cloudStatusUpdate(job(), st("failed", { errorCode: 1, errorTitle: "x".repeat(900) }), NOW);
    expect(String(out?.data.failReason).length).toBe(500);
  });
});

describe("cloudStatusUpdate: the guard is every column written that must still be empty", () => {
  it("each data column that fills a gap (wamid, sentAt, deliveredAt, readAt) is guarded as null", () => {
    const cases: Array<[Partial<StatusJobView>, string]> = [
      [{}, "delivered"],
      [{}, "read"],
      [{ status: "claimed", waMessageId: null, sentAt: null }, "read"],
      [{ status: "unconfirmed", waMessageId: null }, "failed"],
    ];
    for (const [over, s] of cases) {
      const out = cloudStatusUpdate(job(over), st(s), NOW)!;
      for (const col of ["waMessageId", "sentAt", "deliveredAt", "readAt"] as const) {
        if (col in out.data) expect(out.guard).toHaveProperty(col, null);
      }
    }
  });
});

describe("cloudStatusUpdate: jobs a status never touches", () => {
  it("a failed job stays failed, whatever comes later", () => {
    for (const s of ["sent", "delivered", "read", "failed"]) expect(cloudStatusUpdate(job({ status: "failed" }), st(s), NOW)).toBeNull();
  });

  it("a queued job (back in the queue for a retry or a hand over) is not touched", () => {
    for (const s of ["sent", "delivered", "read", "failed"]) expect(cloudStatusUpdate(job({ status: "queued", waMessageId: null }), st(s), NOW)).toBeNull();
  });

  it("a job whose wamid is another message's is not touched", () => {
    expect(cloudStatusUpdate(job({ waMessageId: "wamid.OTHER" }), st("delivered"), NOW)).toBeNull();
  });
});

// Review of #556, S1: a code Meta accepted and then failed (a `failed`
// status after the send) was only marked failed, so the person never got
// it. While the code is alive (ten minutes from createdAt, the Pi's own
// rule) it is handed to the club number (`fallbackWhenCloudDown`, decision
// 5): back in the queue on the club number's channel, as a fresh job for
// the Pi. Only codes; never an expired one; never after it reached him.
describe("cloudStatusUpdate: a code that fails after Meta accepted it (review of #556, S1)", () => {
  const code = (over: Partial<StatusJobView> = {}) => job({ purpose: "otp", createdAt: new Date(NOW.getTime() - 3 * 60_000), ...over });
  const failed = st("failed", { errorCode: 131026, errorTitle: "Message undeliverable" });

  it("alive: handed to the club number, a fresh queued job for the Pi, guarded on the wamid it had", () => {
    expect(cloudStatusUpdate(code(), failed, NOW)).toEqual({
      data: {
        status: "queued",
        channel: "baileys",
        claimedAt: null,
        sendAfter: null,
        waMessageId: null,
        sentAt: null,
        errorCode: 131026,
        failReason: "handed to the club number: Meta status failed: 131026 Message undeliverable",
      },
      guard: { waMessageId: "wamid.A", deliveredAt: null, readAt: null },
      settles: "handover",
    });
  });

  it("from unconfirmed or claimed (no wamid yet) too, guarded on having none", () => {
    for (const status of ["unconfirmed", "claimed"]) {
      const w = cloudStatusUpdate(code({ status, waMessageId: null, sentAt: null }), failed, NOW);
      expect(w).toMatchObject({ data: { status: "queued", channel: "baileys" }, guard: { waMessageId: null, deliveredAt: null, readAt: null }, settles: "handover" });
    }
  });

  it("ten minutes is still alive (the Pi sends it); a moment later it is failed, never handed over", () => {
    expect(cloudStatusUpdate(code({ createdAt: new Date(NOW.getTime() - 10 * 60_000) }), failed, NOW)?.settles).toBe("handover");
    const late = cloudStatusUpdate(code({ createdAt: new Date(NOW.getTime() - 10 * 60_000 - 1) }), failed, NOW);
    expect(late).toMatchObject({ data: { status: "failed", errorCode: 131026 }, settles: "failed" });
    expect(late!.data).not.toHaveProperty("channel");
  });

  it("delivered or read first: it reached him, nothing is handed over", () => {
    expect(cloudStatusUpdate(code({ deliveredAt: AT }), failed, NOW)).toBeNull();
    expect(cloudStatusUpdate(code({ readAt: AT }), failed, NOW)).toBeNull();
  });

  it("a job already on the club number is never handed to it again", () => {
    expect(cloudStatusUpdate(code({ channel: "baileys" }), failed, NOW)?.settles).not.toBe("handover");
  });

  it("every other purpose is unchanged: failed, never handed over", () => {
    for (const purpose of ["pool-offer", "pool-welcome", "pool-placed", "club-invite-ask"]) {
      expect(cloudStatusUpdate(job({ purpose }), failed, NOW)).toMatchObject({ data: { status: "failed" }, settles: "failed" });
    }
  });
});
