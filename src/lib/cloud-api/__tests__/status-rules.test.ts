/**
 * META'S STATUS UPDATES ON A CLOUD JOB (WhatsApp Cloud API plan, PR C5,
 * sections 5.2 and 5.5). Pure. Meta sends sent, delivered, read and failed,
 * repeats them for up to 7 days and may send them out of order, so every
 * rule is idempotent: the same status twice changes nothing the second
 * time. A job the dispatcher left `unconfirmed` (or still `claimed`) is
 * settled by the first status that says what happened.
 */
import { describe, expect, it } from "vitest";
import type { CloudStatusUpdate } from "../inbound";
import { cloudStatusUpdate, type StatusJobView } from "../status-rules";

const NOW = new Date("2026-11-07T12:00:00Z");
const AT = new Date("2026-11-07T11:59:00Z");
const SENT_AT = new Date("2026-11-07T11:58:00Z");

function job(over: Partial<StatusJobView> = {}): StatusJobView {
  return { id: "j1", status: "sent", waMessageId: "wamid.A", sentAt: SENT_AT, deliveredAt: null, readAt: null, ...over };
}
function st(status: string, over: Partial<CloudStatusUpdate> = {}): CloudStatusUpdate {
  return { wamid: "wamid.A", phoneNumberId: "1", status, at: AT, recipient: "447700900001", recipientUserId: null, jobId: "j1", errorCode: null, errorTitle: null, pricing: null, ...over };
}

describe("cloudStatusUpdate: a job the dispatcher recorded as sent", () => {
  it("sent again changes nothing", () => {
    expect(cloudStatusUpdate(job(), st("sent"), NOW)).toBeNull();
  });

  it("delivered stamps deliveredAt with Meta's time, once", () => {
    expect(cloudStatusUpdate(job(), st("delivered"), NOW)).toEqual({ data: { deliveredAt: AT }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: AT }), st("delivered"), NOW)).toBeNull();
  });

  it("read stamps readAt, and deliveredAt too when delivered never came", () => {
    expect(cloudStatusUpdate(job(), st("read"), NOW)).toEqual({ data: { deliveredAt: AT, readAt: AT }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: SENT_AT }), st("read"), NOW)).toEqual({ data: { readAt: AT }, settles: null });
    expect(cloudStatusUpdate(job({ deliveredAt: SENT_AT, readAt: AT }), st("read"), NOW)).toBeNull();
  });

  it("failed marks it failed with Meta's code and title (it never reached him)", () => {
    expect(cloudStatusUpdate(job(), st("failed", { errorCode: 131026, errorTitle: "Message undeliverable" }), NOW)).toEqual({
      data: { status: "failed", failedAt: AT, errorCode: 131026, failReason: "Meta status failed: 131026 Message undeliverable" },
      settles: "failed",
    });
  });

  it("failed after delivered or read is ignored: it reached him", () => {
    expect(cloudStatusUpdate(job({ deliveredAt: AT }), st("failed", { errorCode: 131026 }), NOW)).toBeNull();
    expect(cloudStatusUpdate(job({ readAt: AT }), st("failed", { errorCode: 131026 }), NOW)).toBeNull();
  });

  it("Meta's time missing: now", () => {
    expect(cloudStatusUpdate(job(), st("delivered", { at: null }), NOW)).toEqual({ data: { deliveredAt: NOW }, settles: null });
  });

  it("a status Meta adds later, or an empty one, changes nothing", () => {
    expect(cloudStatusUpdate(job(), st("deleted"), NOW)).toBeNull();
  });
});

describe("cloudStatusUpdate: settling an unconfirmed or still claimed job", () => {
  it("unconfirmed (the send timed out) + sent: sent, with the wamid Meta names", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("sent"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A" },
      settles: "sent",
    });
  });

  it("unconfirmed + delivered: sent and delivered at once", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("delivered"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A", deliveredAt: AT },
      settles: "sent",
    });
  });

  it("claimed (the status beat the dispatcher's own write): sent, with Meta's time as sentAt", () => {
    expect(cloudStatusUpdate(job({ status: "claimed", waMessageId: null, sentAt: null }), st("sent"), NOW)).toEqual({
      data: { status: "sent", waMessageId: "wamid.A", sentAt: AT },
      settles: "sent",
    });
  });

  it("unconfirmed + failed: failed, with the wamid kept", () => {
    expect(cloudStatusUpdate(job({ status: "unconfirmed", waMessageId: null }), st("failed", { errorCode: 131049, errorTitle: null }), NOW)).toEqual({
      data: { status: "failed", failedAt: AT, errorCode: 131049, failReason: "Meta status failed: 131049", waMessageId: "wamid.A" },
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
