/**
 * The thin adapter: each change from `templateStatusChanges` written as one
 * `CloudTemplateStatus` upsert keyed by name and language. A row that fails
 * is logged and skipped; the others are still written.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));

import { applyTemplateStatusPayload, type TemplateStatusClient } from "../template-status";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "1",
      time: 1,
      changes: [
        { field: "message_template_status_update", value: { event: "APPROVED", message_template_id: 7, message_template_name: "mt_pool_offer", message_template_language: "en_GB", reason: "NONE", message_template_category: "UTILITY" } },
        { field: "template_category_update", value: { message_template_id: 7, message_template_name: "mt_pool_offer", message_template_language: "en_GB", previous_category: "UTILITY", new_category: "MARKETING" } },
        { field: "template_category_update", value: { message_template_id: 8, message_template_name: "mt_pool_joined", message_template_language: "tr", correct_category: "MARKETING", new_category: "UTILITY", category_update_timestamp: 1746169200 } },
      ],
    },
  ],
};

function fakeClient(failOn?: string) {
  const upsert = vi.fn(async (args: { where: { name_language: { name: string; language: string } } }) => {
    if (failOn && args.where.name_language.language === failOn) throw new Error("db down");
    return {};
  });
  return { client: { cloudTemplateStatus: { upsert } } as unknown as TemplateStatusClient, upsert };
}

describe("applyTemplateStatusPayload", () => {
  it("upserts each status and category change by (name, language), and counts the upcoming notice", async () => {
    const { client, upsert } = fakeClient();
    const r = await applyTemplateStatusPayload(payload, client);
    expect(r).toEqual({ written: 2, failed: 0, upcoming: 1 });
    expect(upsert.mock.calls.map((c) => c[0])).toEqual([
      {
        where: { name_language: { name: "mt_pool_offer", language: "en_GB" } },
        create: { name: "mt_pool_offer", language: "en_GB", metaTemplateId: "7", status: "APPROVED", category: "UTILITY", reason: null },
        update: { metaTemplateId: "7", status: "APPROVED", category: "UTILITY", reason: null },
      },
      {
        where: { name_language: { name: "mt_pool_offer", language: "en_GB" } },
        create: { name: "mt_pool_offer", language: "en_GB", metaTemplateId: "7", status: "UNKNOWN", category: "MARKETING", previousCategory: "UTILITY" },
        update: { metaTemplateId: "7", category: "MARKETING", previousCategory: "UTILITY" },
      },
    ]);
  });

  it("a failed row is counted and never throws", async () => {
    const { client } = fakeClient("en_GB");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(applyTemplateStatusPayload(payload, client)).resolves.toEqual({ written: 0, failed: 2, upcoming: 1 });
    err.mockRestore();
  });

  it("a payload with nothing for it writes nothing", async () => {
    const { client, upsert } = fakeClient();
    expect(await applyTemplateStatusPayload({ entry: [] }, client)).toEqual({ written: 0, failed: 0, upcoming: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
