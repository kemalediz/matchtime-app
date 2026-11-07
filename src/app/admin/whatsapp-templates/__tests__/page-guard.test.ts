/**
 * /admin/whatsapp-templates is the platform owner's page, guarded as
 * /admin/pool/safety and /admin/health: 404 to anybody who is not
 * `User.isSuperadmin`, before Meta is asked anything or a row is read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/auth", () => authMock);
const orgMock = vi.hoisted(() => ({ isSuperadmin: vi.fn() }));
vi.mock("@/lib/org", () => orgMock);
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);
const dbMock = vi.hoisted(() => ({ db: { cloudTemplateStatus: { findMany: vi.fn(async () => []) } } }));
vi.mock("@/lib/db", () => dbMock);
const sync = vi.hoisted(() => ({ checkCloudTemplates: vi.fn(async () => ({ state: "not-configured" })) }));
vi.mock("@/lib/cloud-api/template-sync-admin", () => sync);
const tokenCheck = vi.hoisted(() => ({
  checkAccessToken: vi.fn(async () => ({
    graphVersion: "v26.0",
    token: { outerWhitespace: false, newline: false },
    env: [],
    debug: { state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" },
    phone: { state: "skipped", reason: "WA_CLOUD_ACCESS_TOKEN is not set" },
    probes: [],
  })),
}));
vi.mock("@/lib/cloud-api/token-check", () => tokenCheck);
vi.mock("@/app/actions/cloud-templates", () => ({ submitCloudTemplatesAction: vi.fn() }));

import WhatsAppTemplatesPage from "../page";

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.mockResolvedValue({ user: { id: "u1" } });
  orgMock.isSuperadmin.mockResolvedValue(true);
});

describe("/admin/whatsapp-templates guard", () => {
  it("a club admin gets 404 and Meta is not asked", async () => {
    orgMock.isSuperadmin.mockResolvedValue(false);
    await expect(WhatsAppTemplatesPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(sync.checkCloudTemplates).not.toHaveBeenCalled();
    expect(tokenCheck.checkAccessToken).not.toHaveBeenCalled();
    expect(dbMock.db.cloudTemplateStatus.findMany).not.toHaveBeenCalled();
  });

  it("nobody signed in goes to the sign-in page", async () => {
    authMock.auth.mockResolvedValue(null);
    await expect(WhatsAppTemplatesPage()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(sync.checkCloudTemplates).not.toHaveBeenCalled();
    expect(tokenCheck.checkAccessToken).not.toHaveBeenCalled();
  });

  it("the owner gets the page, with the dry run, the access token check and the status rows", async () => {
    await expect(WhatsAppTemplatesPage()).resolves.toBeTruthy();
    expect(sync.checkCloudTemplates).toHaveBeenCalledTimes(1);
    expect(tokenCheck.checkAccessToken).toHaveBeenCalledTimes(1);
    expect(dbMock.db.cloudTemplateStatus.findMany).toHaveBeenCalledTimes(1);
  });
});
