// Scratch config: scripts/ is outside the repo's vitest include.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["scripts/_tmp-vets-nov2-plan.test.ts"] },
});
