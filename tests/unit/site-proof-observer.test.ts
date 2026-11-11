import { expect, it, vi } from "vitest";
const transport = vi.hoisted(() => vi.fn());
vi.mock("@/server/acquisition/transport", () => ({
  publicHttpsTransport: transport,
}));
import { observeSiteProof } from "../../apps/lyraseo-web/src/server/acquisition/proof";
it("requires the proof authority check at the transport socket boundary", async () => {
  let sent = 0;
  transport.mockImplementation(
    async (
      _url: string,
      _signal: AbortSignal,
      beforeSocket?: () => Promise<void>,
    ) => {
      expect(typeof beforeSocket).toBe("function");
      await beforeSocket!();
      sent++;
      return new Response("x".repeat(43));
    },
  );
  const beforeSocket = vi.fn(async () => {
    throw Error("FORBIDDEN");
  });
  await expect(
    (observeSiteProof as (...args: unknown[]) => Promise<unknown>)(
      "https://example.com/.well-known/lyraseo-verification.txt",
      beforeSocket,
    ),
  ).rejects.toThrow("FORBIDDEN");
  expect(beforeSocket).toHaveBeenCalledTimes(1);
  expect(sent).toBe(0);
});
