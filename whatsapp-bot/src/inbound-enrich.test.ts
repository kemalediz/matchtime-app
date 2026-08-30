import { describe, it, expect, vi } from "vitest";
import { enrichOrDegrade, planFlushRetry, type InboundEnrichment } from "./inbound-enrich.js";

/**
 * The fallback is now a WHOLE enrichment, not just the raw body.
 *
 * Why it changed (2026-08-30 hardening): the old shape could only preserve
 * the message TEXT when enrichment blew up. It threw away the sender's
 * identity, because the only source of a name was `msg.getContact()` — an
 * injected-page-code call that dies exactly when we need the fallback. The
 * raw payload carries `_data.notifyName`, so the caller can now hand in an
 * identity that survives, and a degraded message still says WHO spoke.
 */
const fb = (over: Partial<InboundEnrichment> = {}): InboundEnrichment => ({
  body: "raw body",
  authorName: null,
  authorPhone: "",
  botMentioned: false,
  ...over,
});

describe("enrichOrDegrade", () => {
  it("passes through a successful enrichment", async () => {
    const onDegrade = vi.fn();
    const out = await enrichOrDegrade(
      fb({ body: "raw @158055467598020 text" }),
      async () => ({
        body: "raw @Elnur Mammadov text",
        authorName: "Kemal",
        authorPhone: "447700900001",
        botMentioned: true,
      }),
      onDegrade,
    );
    expect(out).toEqual({
      body: "raw @Elnur Mammadov text",
      authorName: "Kemal",
      authorPhone: "447700900001",
      botMentioned: true,
    });
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("degrades to the RAW body when enrichment rejects — and never throws", async () => {
    const onDegrade = vi.fn();
    const err = new Error("r"); // the minified whatsapp-web.js page error
    const out = await enrichOrDegrade(
      fb({ body: "in for tuesday" }),
      async () => {
        throw err;
      },
      onDegrade,
    );
    expect(out).toEqual({
      body: "in for tuesday",
      authorName: null,
      authorPhone: "",
      botMentioned: false,
    });
    expect(onDegrade).toHaveBeenCalledOnce();
    expect(onDegrade).toHaveBeenCalledWith(err);
  });

  it("KEEPS the fallback identity when enrichment blows up", async () => {
    // The whole point: a degraded "IN" must still be attributable to a
    // player, or the server drops it and no attendance is recorded.
    const out = await enrichOrDegrade(
      fb({ body: "in", authorName: "Mujeeb", authorPhone: "447700900123" }),
      async () => {
        throw new Error("r");
      },
      vi.fn(),
    );
    expect(out.authorName).toBe("Mujeeb");
    expect(out.authorPhone).toBe("447700900123");
    // botMentioned is a computed signal, not an identity — it cannot be
    // recovered from the raw payload, so it degrades to false.
    expect(out.botMentioned).toBe(false);
  });

  it("degrades when enrichment throws SYNCHRONOUSLY (e.g. calling .catch on undefined)", async () => {
    const onDegrade = vi.fn();
    const out = await enrichOrDegrade(
      fb({ body: "out mate", authorName: "Sam" }),
      () => {
        throw new TypeError("Cannot read properties of undefined (reading 'catch')");
      },
      onDegrade,
    );
    expect(out.body).toBe("out mate");
    expect(out.authorName).toBe("Sam");
    expect(onDegrade).toHaveBeenCalledOnce();
  });

  it("falls back per-FIELD when enrichment returns a partial result", async () => {
    // A half-broken layer is the common case: `getContact()` throws but the
    // rest of enrichment completes. Each field falls back independently
    // rather than the whole enrichment being discarded.
    const onDegrade = vi.fn();
    const out = await enrichOrDegrade(
      fb({ body: "in", authorName: "Ayoub", authorPhone: "447700900222" }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => ({ body: "", authorName: null, botMentioned: true }) as any,
      onDegrade,
    );
    expect(out).toEqual({
      body: "in",
      authorName: "Ayoub",
      authorPhone: "447700900222",
      botMentioned: true,
    });
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("lets enrichment WIN over the fallback for every field it fills", async () => {
    const out = await enrichOrDegrade(
      fb({ body: "in", authorName: "stale", authorPhone: "" }),
      async () => ({
        body: "in @Kemal",
        authorName: "fresh",
        authorPhone: "447700900999",
        botMentioned: true,
      }),
      vi.fn(),
    );
    expect(out).toEqual({
      body: "in @Kemal",
      authorName: "fresh",
      authorPhone: "447700900999",
      botMentioned: true,
    });
  });

  it("never lets a throwing onDegrade escape", async () => {
    await expect(
      enrichOrDegrade(
        fb({ body: "in" }),
        async () => {
          throw new Error("enrich failed");
        },
        () => {
          throw new Error("logger blew up too");
        },
      ),
    ).resolves.toEqual({ body: "in", authorName: null, authorPhone: "", botMentioned: false });
  });

  it("survives a fallback object that is itself junk", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await enrichOrDegrade(null as any, async () => {
      throw new Error("r");
    }, vi.fn());
    expect(out).toEqual({ body: "", authorName: null, authorPhone: "", botMentioned: false });
  });
});

describe("planFlushRetry", () => {
  const p = (id: string, attempts: number) => ({ waMessageId: id, attempts });

  it("requeues a first-failure batch with the attempt count bumped", () => {
    const { requeue, dropped } = planFlushRetry([p("a", 0), p("b", 0)], 3);
    expect(dropped).toEqual([]);
    expect(requeue).toEqual([p("a", 1), p("b", 1)]);
  });

  it("drops messages once they hit the attempt ceiling", () => {
    const { requeue, dropped } = planFlushRetry([p("a", 2), p("b", 0)], 3);
    expect(requeue).toEqual([p("b", 1)]);
    expect(dropped).toEqual([p("a", 3)]);
  });

  it("is pure — it does not mutate the input", () => {
    const input = [p("a", 0)];
    planFlushRetry(input, 3);
    expect(input[0].attempts).toBe(0);
  });

  it("handles an empty batch", () => {
    expect(planFlushRetry([], 3)).toEqual({ requeue: [], dropped: [] });
  });
});
