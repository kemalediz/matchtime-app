/**
 * THE CLOUD DISPATCHER'S PURE RULES (WhatsApp Cloud API plan, PR C4,
 * sections 5.4 and 5.5): free form inside his 24 hour window, the job's
 * template outside it; the daily unique cap holds lower priority jobs and
 * lets codes and placed messages through first; a template Meta paused is
 * not used; the retry count a job carries.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_DAILY_UNIQUE_CAP_DEFAULT,
  CLOUD_WINDOW_MS,
  cloudDailyUniqueCap,
  cloudPriorityOf,
  cloudRetriesOf,
  cloudRetryNote,
  openWindowPhones,
  planCloudSends,
  reachedOutsideWindow,
  templateKey,
  type CloudJobView,
} from "../dispatch-rules";

const NOW = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600_000;

const tmpl = { name: "mt_pool_offer", lang: "en_GB", params: [] };
function job(over: Partial<CloudJobView> = {}): CloudJobView {
  return { id: "j1", phone: "447700900001", purpose: "pool-offer", template: tmpl, ...over };
}
const ctx = (over: Partial<Parameters<typeof planCloudSends>[1]> = {}) => ({
  cap: 200,
  reached: new Set<string>(),
  windowOpen: new Set<string>(),
  unusableTemplates: new Set<string>(),
  ...over,
});

describe("cloudDailyUniqueCap", () => {
  it("defaults to 200, reads a positive whole number, ignores junk", () => {
    expect(CLOUD_DAILY_UNIQUE_CAP_DEFAULT).toBe(200);
    expect(cloudDailyUniqueCap({})).toBe(200);
    expect(cloudDailyUniqueCap({ CLOUD_DAILY_UNIQUE_CAP: "50" })).toBe(50);
    expect(cloudDailyUniqueCap({ CLOUD_DAILY_UNIQUE_CAP: " 0 " })).toBe(0);
    for (const bad of ["-1", "abc", "1.5", ""]) expect(cloudDailyUniqueCap({ CLOUD_DAILY_UNIQUE_CAP: bad })).toBe(200);
  });
});

describe("the 24 hour window", () => {
  it("is open for a number that wrote to the official number in the last 24 hours", () => {
    const open = openWindowPhones(
      [
        { phone: "a", receivedAt: ago(H) },
        { phone: "b", receivedAt: ago(CLOUD_WINDOW_MS + 1) },
        { phone: null, receivedAt: ago(H) },
      ],
      NOW,
    );
    expect([...open]).toEqual(["a"]);
  });
});

describe("reachedOutsideWindow: who counts against Meta's messaging limit", () => {
  it("a number sent to in the last 24 hours with no message from him in the 24 hours before the send", () => {
    const reached = reachedOutsideWindow(
      [
        { phone: "cold", sentAt: ago(2 * H) },
        { phone: "warm", sentAt: ago(2 * H) },
        { phone: "old", sentAt: ago(25 * H) },
        { phone: "laterwrote", sentAt: ago(5 * H) },
      ],
      [
        { phone: "warm", receivedAt: ago(3 * H) },
        // He wrote after the send: that send was still outside a window.
        { phone: "laterwrote", receivedAt: ago(1 * H) },
      ],
      NOW,
    );
    expect([...reached].sort()).toEqual(["cold", "laterwrote"]);
  });
});

describe("cloudPriorityOf", () => {
  it("codes, placed and answers to his own message first; details and invitation asks last", () => {
    expect(cloudPriorityOf("otp")).toBe("first");
    expect(cloudPriorityOf("pool-placed")).toBe("first");
    expect(cloudPriorityOf("pool-reply")).toBe("first");
    expect(cloudPriorityOf("pool-offer")).toBe("normal");
    expect(cloudPriorityOf("pool-paused")).toBe("normal");
    expect(cloudPriorityOf("pool-details-ask")).toBe("low");
    expect(cloudPriorityOf("club-invite-ask")).toBe("low");
  });
});

describe("planCloudSends: free form or template", () => {
  it("inside his window: free form text", () => {
    expect(planCloudSends([job()], ctx({ windowOpen: new Set(["447700900001"]) }))).toEqual([{ jobId: "j1", action: "send", mode: "text" }]);
  });

  it("outside it: the job's template", () => {
    expect(planCloudSends([job()], ctx())).toEqual([{ jobId: "j1", action: "send", mode: "template" }]);
  });

  it("outside it with no template: failed, never sent as free form", () => {
    expect(planCloudSends([job({ template: null })], ctx())[0]).toMatchObject({ action: "fail" });
  });

  it("template parameters that are not a list: failed", () => {
    expect(planCloudSends([job({ template: { ...tmpl, params: { a: 1 } } })], ctx())[0]).toMatchObject({ action: "fail" });
    expect(planCloudSends([job({ template: { ...tmpl, params: null } })], ctx())[0]).toMatchObject({ action: "send", mode: "template" });
  });

  it("a template Meta paused, disabled or has not approved is held, not used", () => {
    const plan = planCloudSends([job()], ctx({ unusableTemplates: new Set([templateKey("mt_pool_offer", "en_GB")]) }));
    expect(plan[0]).toMatchObject({ action: "hold" });
  });

  it("inside the window a paused template does not matter", () => {
    const plan = planCloudSends([job()], ctx({ windowOpen: new Set(["447700900001"]), unusableTemplates: new Set([templateKey("mt_pool_offer", "en_GB")]) }));
    expect(plan[0]).toEqual({ jobId: "j1", action: "send", mode: "text" });
  });
});

describe("planCloudSends: the daily unique cap", () => {
  const full = (n: number) => new Set(Array.from({ length: n }, (_, i) => `r${i}`));

  it("under the cap: everyone goes", () => {
    expect(planCloudSends([job()], ctx({ cap: 2, reached: full(1) }))[0]).toMatchObject({ action: "send" });
  });

  it("at the cap: a pool offer to a new person is held", () => {
    expect(planCloudSends([job()], ctx({ cap: 2, reached: full(2) }))[0]).toMatchObject({ action: "hold" });
  });

  it("at the cap: codes and placed messages still go", () => {
    const plan = planCloudSends([job({ id: "c", purpose: "otp" }), job({ id: "p", phone: "4477009000002", purpose: "pool-placed" })], ctx({ cap: 2, reached: full(2) }));
    expect(plan.map((p) => p.action)).toEqual(["send", "send"]);
  });

  it("at the cap: someone already reached today does not count again", () => {
    expect(planCloudSends([job({ phone: "r0" })], ctx({ cap: 1, reached: full(1) }))[0]).toMatchObject({ action: "send" });
  });

  it("at the cap: a message inside his window does not count", () => {
    expect(planCloudSends([job()], ctx({ cap: 0, windowOpen: new Set(["447700900001"]) }))[0]).toMatchObject({ action: "send", mode: "text" });
  });

  it("one place left: codes first, then normal, then low, whatever the batch order", () => {
    const plan = planCloudSends(
      [
        job({ id: "low", phone: "1", purpose: "pool-details-ask" }),
        job({ id: "offer", phone: "2", purpose: "pool-offer" }),
        job({ id: "code", phone: "3", purpose: "otp" }),
      ],
      ctx({ cap: 1 }),
    );
    expect(plan.map((p) => [p.jobId, p.action])).toEqual([
      ["code", "send"],
      ["offer", "hold"],
      ["low", "hold"],
    ]);
  });

  it("two jobs to one new person use one place", () => {
    const plan = planCloudSends([job({ id: "a" }), job({ id: "b", purpose: "pool-paused" })], ctx({ cap: 1 }));
    expect(plan.map((p) => p.action)).toEqual(["send", "send"]);
  });
});

describe("the retry count a job carries", () => {
  it("round trips through the note, and anything else is zero", () => {
    expect(cloudRetriesOf(cloudRetryNote(2, "Meta 130429 (HTTP 429)"))).toBe(2);
    expect(cloudRetriesOf(null)).toBe(0);
    expect(cloudRetriesOf("cancelled: the ask closed")).toBe(0);
    expect(cloudRetriesOf("cloud hold: daily cap")).toBe(0);
  });
});
