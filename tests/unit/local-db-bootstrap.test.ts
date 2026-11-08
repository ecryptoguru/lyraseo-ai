import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as expiryGuard from "../../scripts/lib/expiry-bootstrap.mjs";
import * as legacyGuard from "../../scripts/lib/legacy-visibility-role.mjs";
import { LOCAL_GRANT_BOOTSTRAP } from "../../scripts/lib/local-grants.mjs";

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

function freshContainer(
  finalStarts: boolean,
  unsafeExpiry = false,
  unsafeLegacy = false,
  unsafeJob = false,
) {
  const probes: string[] = [];
  const queries: string[] = [];
  const statements: string[] = [];
  const inputs: string[] = [];
  let phase = "temporary";
  spawn.mockImplementation(
    (command: string, args: string[], options?: { input?: string }) => {
      if (command === "docker") {
        if (args[0] === "inspect") return { status: 1 }; // new container
        if (args.includes("pg_isready")) {
          phase =
            ["temporary", "gap"][probes.length] ??
            (finalStarts ? "final" : "offline");
          probes.push(phase);
          const host = args.includes("-h")
            ? args[args.indexOf("-h") + 1]
            : null;
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
          if (typeof options?.input === "string") inputs.push(options.input);
          queries.push(phase);
          const statement = args[args.indexOf("-c") + 1];
          if (statement) statements.push(statement);
          if (phase !== "final")
            return {
              status: 1,
              stderr: "socket disappeared during initialization",
            };
          return {
            status: 0,
            stdout:
              (unsafeExpiry && statement === expiryGuard.EXPIRY_ROLE_GUARD) ||
              (unsafeLegacy &&
                statement === legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD) ||
              (unsafeJob && statement?.includes("lyraseo_staff_job_owner"))
                ? "t\n"
                : "f\n",
          };
        }
        if (!["info", "run"].includes(args[0]!))
          throw new Error("Unexpected Docker operation");
      } else if (command !== "pnpm")
        throw new Error("Unexpected bootstrap process");
      return { status: 0 };
    },
  );
  return { probes, queries, statements, inputs };
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

it("executes exactly one shared expiry role guard", async () => {
  const observed = freshContainer(true);
  expect(typeof expiryGuard.EXPIRY_ROLE_GUARD).toBe("string");
  await bootstrap();
  expect(
    observed.statements.filter(
      (sql) => sql.trim() === expiryGuard.EXPIRY_ROLE_GUARD.trim(),
    ),
  ).toHaveLength(1);
});

it("executes the exact shared grant bootstrap once after migration", async () => {
  const observed = freshContainer(true);
  await bootstrap();
  expect(
    observed.inputs.filter((sql) => sql === LOCAL_GRANT_BOOTSTRAP),
  ).toHaveLength(1);
  expect(LOCAL_GRANT_BOOTSTRAP).toContain("UNSAFE_LEGACY_BOOTSTRAP_GRANT");
});

it("detects commented-out or replaced live grant-bootstrap calls despite decoys", async () => {
  const source = readFileSync(
    new URL("../../scripts/local-db.mjs", import.meta.url),
    "utf8",
  );
  const live = "input: LOCAL_GRANT_BOOTSTRAP";
  expect(source).toContain(live);
  const run = async (program: string) => {
    const observed = freshContainer(true);
    const body = program.replace(/^import .*;\n/gm, "");
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(
      "spawnSync",
      "EXPIRY_ROLE_GUARD",
      "LOCAL_GRANT_BOOTSTRAP",
      "LEGACY_VISIBILITY_ROLE_GUARD",
      body,
    )(
      spawn,
      expiryGuard.EXPIRY_ROLE_GUARD,
      LOCAL_GRANT_BOOTSTRAP,
      legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD,
    );
    if (
      observed.inputs.filter((sql) => sql === LOCAL_GRANT_BOOTSTRAP).length !==
      1
    )
      throw Error("LOCAL_GRANT_BOOTSTRAP_NOT_UNIQUE_OR_MISSING");
  };
  await expect(run(source)).resolves.toBeUndefined();
  await expect(
    run(source.replace(live, "input: 'SELECT false'") + `\n/* ${live} */`),
  ).rejects.toThrow("LOCAL_GRANT_BOOTSTRAP_NOT_UNIQUE_OR_MISSING");
  await expect(
    run(`${source}\nrun('docker', ['psql'], {input: LOCAL_GRANT_BOOTSTRAP});`),
  ).rejects.toThrow("LOCAL_GRANT_BOOTSTRAP_NOT_UNIQUE_OR_MISSING");
});

it("provisions the dedicated NOLOGIN job role before migration", async () => {
  const observed = freshContainer(true);
  await bootstrap();
  const provision = observed.inputs.find((sql) =>
    sql.includes("CREATE ROLE lyraseo_staff_job_owner"),
  );
  expect(provision).toContain(
    "CREATE ROLE lyraseo_staff_job_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS",
  );
  expect(
    observed.statements.some(
      (sql) =>
        sql.includes("lyraseo_staff_job_owner") &&
        sql.includes("pg_auth_members") &&
        sql.includes("pg_database") &&
        sql.includes("pg_proc"),
    ),
  ).toBe(true);
});

it("refuses an unsafe existing staff job role before provisioning or migration", async () => {
  const observed = freshContainer(true, false, false, true);
  await expect(bootstrap()).rejects.toThrow("Unsafe existing staff job role");
  expect(observed.inputs).toEqual([]);
  expect(
    spawn.mock.calls.filter(([command]) => command === "pnpm"),
  ).toHaveLength(0);
});

it("refuses unsafe expiry roles before provisioning or migration", async () => {
  const observed = freshContainer(true, true);
  await expect(bootstrap()).rejects.toThrow("Unsafe existing expiry role");
  expect(observed.statements).toContain(expiryGuard.EXPIRY_ROLE_GUARD);
  expect(
    spawn.mock.calls.filter(([command]) => command === "pnpm"),
  ).toHaveLength(0);
});

it("detects leading-whitespace duplicate and commented-out live guard substitutions", async () => {
  expect(typeof expiryGuard.EXPIRY_ROLE_GUARD).toBe("string");
  const source = readFileSync(
    new URL("../../scripts/local-db.mjs", import.meta.url),
    "utf8",
  );
  const live = "localScalar(EXPIRY_ROLE_GUARD)";
  expect(source).toContain(live);
  const run = async (program: string) => {
    const observed = freshContainer(true);
    const body = program.replace(/^import .*;\n/gm, "");
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(
      "spawnSync",
      "EXPIRY_ROLE_GUARD",
      "LOCAL_GRANT_BOOTSTRAP",
      "LEGACY_VISIBILITY_ROLE_GUARD",
      body,
    )(
      spawn,
      expiryGuard.EXPIRY_ROLE_GUARD,
      LOCAL_GRANT_BOOTSTRAP,
      legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD,
    );
    const guardCalls = observed.statements.filter(
      (sql) => sql.trim() === expiryGuard.EXPIRY_ROLE_GUARD.trim(),
    ).length;
    if (guardCalls !== 1) throw Error("EXPIRY_GUARD_NOT_UNIQUE_OR_MISSING");
  };
  await expect(run(source)).resolves.toBeUndefined();
  const duplicate = `${source}\nlocalScalar(\` \n${expiryGuard.EXPIRY_ROLE_GUARD}\`);`;
  await expect(run(duplicate)).rejects.toThrow(
    "EXPIRY_GUARD_NOT_UNIQUE_OR_MISSING",
  );
  const commented =
    source.replace(live, "localScalar(`SELECT false`)") + `\n/* ${live} */`;
  await expect(run(commented)).rejects.toThrow(
    "EXPIRY_GUARD_NOT_UNIQUE_OR_MISSING",
  );
});

it("executes the shared legacy visibility guard once and refuses an unsafe identity", async () => {
  const safe = freshContainer(true);
  await bootstrap();
  expect(
    safe.statements.filter(
      (sql) => sql.trim() === legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD.trim(),
    ),
  ).toHaveLength(1);
  vi.resetModules();
  spawn.mockReset();
  const unsafe = freshContainer(true, false, true);
  await expect(bootstrap()).rejects.toThrow(
    "Unsafe existing legacy visibility role",
  );
  expect(unsafe.statements).toContain(legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD);
  expect(
    spawn.mock.calls.filter(([command]) => command === "pnpm"),
  ).toHaveLength(0);
});

it("detects a duplicate or commented-out legacy visibility role guard", async () => {
  const source = readFileSync(
    new URL("../../scripts/local-db.mjs", import.meta.url),
    "utf8",
  );
  const live = "localScalar(LEGACY_VISIBILITY_ROLE_GUARD)";
  expect(source).toContain(live);
  const run = async (program: string) => {
    const observed = freshContainer(true);
    const body = program.replace(/^import .*;\n/gm, "");
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction(
      "spawnSync",
      "EXPIRY_ROLE_GUARD",
      "LEGACY_VISIBILITY_ROLE_GUARD",
      "LOCAL_GRANT_BOOTSTRAP",
      body,
    )(
      spawn,
      expiryGuard.EXPIRY_ROLE_GUARD,
      legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD,
      LOCAL_GRANT_BOOTSTRAP,
    );
    if (
      observed.statements.filter(
        (sql) => sql.trim() === legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD.trim(),
      ).length !== 1
    )
      throw Error("LEGACY_VISIBILITY_GUARD_NOT_UNIQUE_OR_MISSING");
  };
  await expect(run(source)).resolves.toBeUndefined();
  await expect(
    run(
      `${source}\nlocalScalar(\` \n${legacyGuard.LEGACY_VISIBILITY_ROLE_GUARD}\`);`,
    ),
  ).rejects.toThrow("LEGACY_VISIBILITY_GUARD_NOT_UNIQUE_OR_MISSING");
  await expect(
    run(
      source.replace(live, "localScalar(`SELECT false`)") + `\n/* ${live} */`,
    ),
  ).rejects.toThrow("LEGACY_VISIBILITY_GUARD_NOT_UNIQUE_OR_MISSING");
});
