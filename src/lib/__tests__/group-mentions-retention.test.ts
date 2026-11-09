/**
 * "@Match Time DM these people" keeps who was tagged for 7 days, then the
 * daily cron deletes it (`purgeOldMentions`). Database mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteMany = vi.fn();
vi.mock("@/lib/db", () => ({ db: { messageMentions: { deleteMany: (...a: unknown[]) => deleteMany(...a) } } }));

import { purgeOldMentions } from "@/lib/group-mentions";

beforeEach(() => vi.clearAllMocks());

describe("purgeOldMentions", () => {
  it("deletes every row sent more than 7 days ago, in every club", async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    expect(await purgeOldMentions(new Date("2026-11-09T06:00:00Z"))).toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({ where: { sentAt: { lt: new Date("2026-11-02T06:00:00Z") } } });
  });

  it("a failure (the table not migrated yet) is 0, never a throw into the cron", async () => {
    deleteMany.mockRejectedValue(new Error('relation "MessageMentions" does not exist'));
    expect(await purgeOldMentions(new Date("2026-11-09T06:00:00Z"))).toBe(0);
  });
});
