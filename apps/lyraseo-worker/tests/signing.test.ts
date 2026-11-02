import { expect, it } from "vitest";
import vectors from "../../../tests/fixtures/runtime/signing-v1.json";
import {
  authenticateRuntime,
  runtimeBodyLimit,
  runtimePaths,
  type RuntimePath,
} from "@lyraseo/contracts/runtime-signing";
import { configuration, signEnvelope } from "../src/bridge";
import { enabled } from "./helpers";
for (const vector of vectors)
  it(`workerd Python vector ${vector.path}`, async () => {
    const config = configuration(enabled());
    const e = await signEnvelope(
      config,
      vector.path as RuntimePath,
      vector.raw,
      1800000000,
      "00000000-0000-4000-8000-000000000001",
    );
    expect(e.headers.get("x-lyra-signature")).toBe(vector.signature);
    const bytes = new TextEncoder().encode(e.body);
    const keys = [
      {
        id: config.keyId,
        principal: "lyraseo_dispatch" as const,
        audience: "lyraseo-kernel-a" as const,
        actions: runtimePaths,
        secret: config.secret,
      },
    ];
    await expect(
      authenticateRuntime(e.path, e.headers, bytes, keys, 1800000001),
    ).resolves.toMatchObject({ rawBody: vector.raw });
    await expect(
      authenticateRuntime(e.path, e.headers, bytes, keys, 1800000060),
    ).rejects.toThrow();
    await expect(
      authenticateRuntime(e.path, e.headers, bytes, [], 1800000001),
    ).rejects.toThrow();
    for (const [name, value] of [
      ["audience", "wrong"],
      ["key-id", "wrong"],
      ["request-id", "bad"],
      ["issued-at", "1800000040"],
      ["expires-at", "1800000061"],
    ]) {
      const h = new Headers(e.headers);
      h.set("x-lyra-" + name, value!);
      await expect(
        authenticateRuntime(e.path, h, bytes, keys, 1800000001),
      ).rejects.toThrow();
    }
    await expect(
      authenticateRuntime(
        e.path,
        e.headers,
        new TextEncoder().encode(e.body + " "),
        keys,
        1800000001,
      ),
    ).rejects.toThrow();
    if (e.path.endsWith("/ack") || e.path.endsWith("/defer"))
      await expect(
        authenticateRuntime(
          e.path === runtimePaths[1] ? runtimePaths[2] : runtimePaths[1],
          e.headers,
          bytes,
          keys,
          1800000001,
        ),
      ).rejects.toThrow();
  });
it("rejects every oversized request before signing", async () => {
  for (const path of runtimePaths)
    await expect(
      signEnvelope(
        configuration(enabled()),
        path,
        JSON.stringify({ limit: 1, padding: "a".repeat(8193) }),
      ),
    ).rejects.toThrow();
});

it("exact per-action request byte ceilings include raw whitespace", async () => {
  for (const vector of vectors) {
    const path = vector.path as RuntimePath;
    const limit = runtimeBodyLimit(path);
    const raw =
      vector.raw +
      " ".repeat(limit - new TextEncoder().encode(vector.raw).length);
    await expect(
      signEnvelope(configuration(enabled()), path, raw),
    ).resolves.toMatchObject({ body: raw });
    await expect(
      signEnvelope(configuration(enabled()), path, raw + " "),
    ).rejects.toThrow("CONFIGURATION");
  }
});
