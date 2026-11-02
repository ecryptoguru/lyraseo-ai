import { afterEach, beforeEach, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawnSync: spawn }));

const realSetTimeout = globalThis.setTimeout;
beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
  // Keep the script's real polling/attempt logic, without 15s of test sleeps.
  vi.stubGlobal("setTimeout", (callback: () => void, delay: number) =>
    realSetTimeout(callback, delay === 500 ? 0 : delay),
  );
});
afterEach(() => vi.unstubAllGlobals());

function freshContainer(finalStarts: boolean) {
  const probes: string[] = [];
  const queries: string[] = [];
  let phase = "temporary";
  spawn.mockImplementation((command: string, args: string[]) => {
    if (command === "docker") {
      if (args[0] === "inspect") return { status: 1 }; // new container
      if (args.includes("pg_isready")) {
        phase =
          ["temporary", "gap"][probes.length] ??
          (finalStarts ? "final" : "offline");
        probes.push(phase);
        const host = args.includes("-h") ? args[args.indexOf("-h") + 1] : null;
        // The temporary setup server serves only its Unix socket.
        const validTcp =
          host === "127.0.0.1" &&
          args[args.indexOf("-p") + 1] === "5432" &&
          args[args.indexOf("-d") + 1] === "lyraseo_test" &&
          args[args.indexOf("-U") + 1] === "postgres";
        const ready =
          host === null
            ? phase === "temporary" || phase === "final"
            : validTcp && phase === "final";
        return { status: ready ? 0 : 2 };
      }
      if (args.includes("psql")) {
        queries.push(phase);
        if (phase !== "final")
          return {
            status: 1,
            stderr: "socket disappeared during initialization",
          };
        return { status: 0, stdout: "f\n" };
      }
      if (!["info", "run"].includes(args[0]!))
        throw new Error("Unexpected Docker operation");
    } else if (command !== "pnpm")
      throw new Error("Unexpected bootstrap process");
    return { status: 0 };
  });
  return { probes, queries };
}

const bootstrap = () => import("../../scripts/local-db.mjs");

it("waits through socket-only initialization and shutdown before any cutover or provisioning query", async () => {
  const observed = freshContainer(true);
  await bootstrap();
  expect(observed.probes).toEqual(["temporary", "gap", "final"]);
  expect(observed.queries.length).toBeGreaterThan(0);
  expect(new Set(observed.queries)).toEqual(new Set(["final"]));
});

it("fails after the bounded probe budget without issuing cutover or provisioning queries", async () => {
  const observed = freshContainer(false);
  await expect(bootstrap()).rejects.toThrow(
    "Local PostgreSQL did not become ready.",
  );
  expect(observed.probes).toHaveLength(30);
  expect(observed.queries).toEqual([]);
  expect(
    spawn.mock.calls.filter(([command]) => command === "pnpm"),
  ).toHaveLength(0);
});
