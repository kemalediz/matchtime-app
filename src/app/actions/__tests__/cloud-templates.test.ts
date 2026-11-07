/**
 * "Submit to Meta" on the owner's WhatsApp templates page. A server action
 * is a public endpoint, so the superadmin check is here, not only on the
 * page: anybody else is refused and nothing reaches Meta.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ isSuperadmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const sync = vi.hoisted(() => ({ submitCloudTemplates: vi.fn() }));
vi.mock("@/lib/cloud-api/template-sync-admin", () => sync);

import { submitCloudTemplatesAction } from "../cloud-templates";

const DONE = { state: "ok", diffs: [], applied: [{ name: "mt_code", language: "tr", action: "created" }], skipped: [], failed: [] };

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u1" } });
  orgMock.isSuperadmin.mockResolvedValue(true);
  sync.submitCloudTemplates.mockResolvedValue(DONE);
});

describe("submitCloudTemplatesAction", () => {
  it("the owner submits and gets the per-template result", async () => {
    expect(await submitCloudTemplatesAction()).toEqual(DONE);
    expect(sync.submitCloudTemplates).toHaveBeenCalledTimes(1);
  });

  it("a club admin is refused and nothing is submitted", async () => {
    orgMock.isSuperadmin.mockResolvedValue(false);
    expect(await submitCloudTemplatesAction()).toEqual({ state: "forbidden" });
    expect(sync.submitCloudTemplates).not.toHaveBeenCalled();
  });

  it("nobody signed in is refused and nothing is submitted", async () => {
    authMock.auth.mockResolvedValue(null);
    expect(await submitCloudTemplatesAction()).toEqual({ state: "forbidden" });
    expect(orgMock.isSuperadmin).not.toHaveBeenCalled();
    expect(sync.submitCloudTemplates).not.toHaveBeenCalled();
  });
});
