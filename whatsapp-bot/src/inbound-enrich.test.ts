import { describe, it, expect, vi } from "vitest";
import { enrichOrDegrade, planFlushRetry } from "./inbound-enrich.js";

describe("enrichOrDegrade", () => {
  it("passes through a successful enrichment", async () => {
    const onDegrade = vi.fn();
    const out = await enrichOrDegrade(
      "raw @158055467598020 text",
      async () => ({
        body: "raw @Elnur Mammadov text",
        authorName: "Kemal",
        botMentioned: true,
      }),
      onDegrade,
    );
    expect(out).toEqual({
      body: "raw @Elnur Mammadov text",
      authorName: "Kemal",
      botMentioned: true,
    });
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("degrades to the RAW body when enrichment rejects — and never throws", async () => {
    const onDegrade = vi.fn();
    const err = new Error("r"); // the minified whatsapp-web.js page error
    const out = await enrichOrDegrade(
      "in for tuesday",
      async () => {
        throw err;
      },
      onDegrade,
    );
    expect(out).toEqual({ body: "in for tuesday", authorName: null, botMentioned: false });
    expect(onDegrade).toHaveBeenCalledOnce();
    expect(onDegrade).toHaveBeenCalledWith(err);
  });

  it("degrades when enrichment throws SYNCHRONOUSLY (e.g. calling .catch on undefined)", async () => {
    const onDegrade = vi.fn();
    const out = await enrichOrDegrade(
      "out mate",
      () => {
        throw new TypeError("Cannot read properties of undefined (reading 'catch')");
      },
      onDegrade,
    );
    expect(out.body).toBe("out mate");
    expect(onDegrade).toHaveBeenCalledOnce();
  });

  it("falls back to the raw body when enrichment returns an empty/garbage body", async () => {
    const onDegrade = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await enrichOrDegrade("in", async () => ({ body: "" }) as any, onDegrade);
    expect(out).toEqual({ body: "in", authorName: null, botMentioned: false });
    expect(onDegrade).not.toHaveBeenCalled();
  });

  it("never lets a throwing onDegrade escape", async () => {
    await expect(
      enrichOrDegrade(
        "in",
        async () => {
          throw new Error("enrich failed");
        },
        () => {
          throw new Error("logger blew up too");
        },
      ),
    ).resolves.toEqual({ body: "in", authorName: null, botMentioned: false });
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
