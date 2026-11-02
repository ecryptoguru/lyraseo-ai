import { describe, expect, it } from "vitest";
import vectors from "../fixtures/runtime/signing-v1.json";
import {
  authenticateRuntime,
  canonicalRuntimeBytes,
  parseRuntimeBody,
  runtimePaths,
  type RuntimePath,
} from "../../packages/contracts/src/runtime-signing";
const keys = [
  {
    id: "test-2026",
    principal: "lyraseo_dispatch",
    audience: "lyraseo-kernel-a",
    actions: runtimePaths,
    secret: Uint8Array.from({ length: 32 }, (_, i) => i),
  },
] as const;
const headers = (signature: string) =>
  new Headers({
    "x-lyra-key-id": "test-2026",
    "x-lyra-principal": "lyraseo_dispatch",
    "x-lyra-audience": "lyraseo-kernel-a",
    "x-lyra-issued-at": "1800000000",
    "x-lyra-expires-at": "1800000060",
    "x-lyra-request-id": "00000000-0000-4000-8000-000000000001",
    "x-lyra-signature": signature,
  });
describe("lyra-runtime-v1 Python struct/HMAC golden vectors", () => {
  for (const v of vectors)
    it(v.path, async () => {
      const path = v.path as RuntimePath,
        h = headers(v.signature);
      expect(Object.fromEntries(h)).toEqual(v.headers);
      const bytes = canonicalRuntimeBytes(path, h, v.sha);
      const lengths: number[] = [];
      const view = new DataView(bytes.buffer);
      for (let offset = 0; offset < bytes.length;) {
        const size = view.getUint32(offset);
        lengths.push(size);
        offset += 4 + size;
      }
      expect(lengths).toEqual(v.lengths);
      const b = new TextEncoder().encode(v.raw);
      expect(
        Buffer.from(canonicalRuntimeBytes(path, h, v.sha)).toString("hex"),
      ).toBe(v.canonicalHex);
      const verify = () => authenticateRuntime(path, h, b, keys, 1800000001);
      expect((await verify()).rawBody).toBe(v.raw);
      expect(parseRuntimeBody(path, v.raw)).toEqual(JSON.parse(v.raw));
      await expect(
        authenticateRuntime(path, h, b, keys, 1800000060),
      ).rejects.toThrow();
      await expect(
        authenticateRuntime(path, h, b, [], 1800000001),
      ).rejects.toThrow();
      await expect(
        authenticateRuntime(
          path,
          h,
          new TextEncoder().encode(v.raw + " "),
          keys,
          1800000001,
        ),
      ).rejects.toThrow();
      if (path.endsWith("/ack") || path.endsWith("/defer"))
        await expect(
          authenticateRuntime(
            path.endsWith("/ack") ? runtimePaths[2] : runtimePaths[1],
            h,
            b,
            keys,
            1800000001,
          ),
        ).rejects.toThrow();
      h.append("x-lyra-request-id", h.get("x-lyra-request-id")!);
      await expect(verify()).rejects.toThrow();
    });
  it("rejects collapsed duplicate keys, nested or ambiguous values", () => {
    for (const raw of [
      '{"limit":1,"limit":2}',
      '{"limit":1,"lim\\u0069t":2}',
      '{"limit":[1]}',
      '{"limit":1,"owner":1}',
      '{"limit":1e0}',
      '{"limit":0}',
    ])
      expect(() => parseRuntimeBody(runtimePaths[0], raw)).toThrow();
  });
});
it("decodes escaped JSON keys before checking duplicate semantics", () => {
  expect(
    parseRuntimeBody(runtimePaths[0], String.raw`{"lim\u0069t":2}`),
  ).toEqual({ limit: 2 });
  expect(() =>
    parseRuntimeBody(runtimePaths[0], String.raw`{"lim\u0069t":2,"limit":1}`),
  ).toThrow();
});
