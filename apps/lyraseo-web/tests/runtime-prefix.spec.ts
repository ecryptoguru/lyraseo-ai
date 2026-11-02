import { expect, test } from "@playwright/test";
import { runtimePaths } from "@lyraseo/contracts/runtime-signing";

test("stock Next keeps all runtime paths inert even with browser credentials", async ({
  request,
}) => {
  for (const path of [...runtimePaths, "/api/internal/runtime/unknown"]) {
    const response = await request.post(path, {
      headers: {
        cookie: "sb-pilot-auth-token=fabricated",
        "x-lyra-key-id": "fixture",
      },
      data: { limit: 1 },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(404);
    expect(await response.text()).toBe("");
    expect(response.headers()["cache-control"]).toContain("no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
});
