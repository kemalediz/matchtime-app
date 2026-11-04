/**
 * POST /api/play/visit (visits 2026-11-03, steps 2026-11-04): the /play
 * page's beacon for the two steps only the browser sees, opened and
 * started. It answers at once and records AFTER the answer (`after`), so a
 * count never slows the page, and whatever it is sent it never fails the
 * caller. Sent and confirmed are counted by the server where they happen,
 * so a page claiming them counts nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const later = vi.hoisted(() => ({ tasks: [] as Array<() => unknown> }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => later.tasks.push(fn) }));
const visits = vi.hoisted(() => ({ recordPoolVisit: vi.fn() }));
vi.mock("@/lib/pool/visits", () => visits);

import { POST } from "../route";

const PERSON = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const req = (body: string, ua: string | null = PERSON) =>
  new Request("http://localhost/api/play/visit", { method: "POST", body, headers: ua === null ? {} : { "user-agent": ua } });

beforeEach(() => {
  vi.clearAllMocks();
  later.tasks.length = 0;
  visits.recordPoolVisit.mockResolvedValue("fb-sutton");
});

describe("POST /api/play/visit", () => {
  it("answers 204 before recording, then records the code it was sent, the step and the user agent", async () => {
    const res = await POST(req(JSON.stringify({ src: "FB-Sutton", ref: "", step: "started" })));
    expect(res.status).toBe(204);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
    expect(later.tasks).toHaveLength(1);
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith({
      source: { campaignCode: "fb-sutton", referralCode: null },
      userAgent: PERSON,
      now: expect.any(Date),
      step: "started",
    });
  });

  it("no step is opened: a page cached before steps existed still counts its visit", async () => {
    await POST(req(JSON.stringify({ src: "fb-sutton" })));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ step: "opened" }));
  });

  it("a page claiming sent or confirmed, or any other step, gets 204 and counts nothing", async () => {
    for (const step of ["sent", "confirmed", "paid", 3]) {
      expect((await POST(req(JSON.stringify({ src: "fb-sutton", step })))).status).toBe(204);
    }
    expect(later.tasks).toHaveLength(0);
    expect(visits.recordPoolVisit).not.toHaveBeenCalled();
  });

  it("a body that is not JSON counts as plain /play, opened", async () => {
    expect((await POST(req("not json"))).status).toBe(204);
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ source: { campaignCode: null, referralCode: null }, step: "opened" }));
  });

  it("no user agent is passed on as none (the recorder treats it as a fetcher)", async () => {
    await POST(req("{}", null));
    await later.tasks[0]();
    expect(visits.recordPoolVisit).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
  });
});
