import { expect, it, vi } from "vitest";
import { proxy } from "../../apps/lyraseo-web/src/proxy";
import { runtimePaths } from "../../packages/contracts/src/runtime-signing";
const settings = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("runtime path consulted browser auth");
  }),
);
vi.mock("../../apps/lyraseo-web/src/server/auth/settings", () => ({
  authSettings: settings,
}));
it("denies reserved paths before consulting auth configuration, sessions or cookies", async () => {
  for (const pathname of [...runtimePaths, "/api/internal/runtime/nested"]) {
    const request = {
      nextUrl: { pathname },
      get cookies() {
        throw new Error("runtime path consulted cookies");
      },
    };
    const response = await proxy(request as Parameters<typeof proxy>[0]);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
  expect(settings).not.toHaveBeenCalled();
});
