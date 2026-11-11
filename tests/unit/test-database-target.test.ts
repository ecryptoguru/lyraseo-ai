import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  execute: vi.fn(),
  disconnect: vi.fn(),
}));
const spawn = vi.hoisted(() => vi.fn());
const fixtureReceipts: string[] = [];
vi.mock("node:child_process", () => ({ spawnSync: spawn }));
// Never let a negative safety test connect to the canonical database.
vi.mock("../../packages/db/src", () => ({
  createDatabase: database.connect,
}));

beforeEach(() => {
  vi.resetModules();
  spawn.mockReset();
  vi.stubEnv("LYRA_TEST_DB_NAME", undefined);
  vi.stubEnv("LYRA_TEST_DB_HOST_PORT", undefined);
  vi.stubEnv("LYRA_TEST_DB_ADMIN_PASSWORD", undefined);
  database.connect.mockReset().mockReturnValue({
    $executeRawUnsafe: database.execute.mockReset().mockResolvedValue(0),
    $disconnect: database.disconnect.mockReset().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const path of fixtureReceipts.splice(0))
    rmSync(path, { recursive: true });
});

const helper = () => import("../helpers/database");

it("constructs restricted test-role URLs independently of the administrator password", async () => {
  const { testDatabaseRoleUrl } =
    await import("../helpers/test-database-target");
  const env = {
    LYRA_TEST_DB_NAME: "lyraseo_review_0123456789ab",
    LYRA_TEST_DB_HOST_PORT: "54335",
    LYRA_TEST_DB_ADMIN_PASSWORD: "different_admin_password",
  };
  for (const [role, password] of [
    ["lyraseo_runtime", "local_runtime_only"],
    ["lyraseo_identity", "local_identity_only"],
    ["lyraseo_dispatch", "local_dispatch_only"],
  ]) {
    const url = new URL(testDatabaseRoleUrl(role, env));
    expect(url.username).toBe(role);
    expect(url.password).toBe(password);
    expect(url.port).toBe("54335");
    expect(url.pathname).toBe("/lyraseo_review_0123456789ab");
  }
  expect(() => testDatabaseRoleUrl("postgres", env)).toThrow(
    "INVALID_LOCAL_TEST_ROLE",
  );
});

it("refuses an implicit canonical reset before opening a connection", async () => {
  const { resetDatabase } = await helper();
  await expect(resetDatabase()).rejects.toThrow(
    "OWNED_LOCAL_TEST_DATABASE_REQUIRED",
  );
  expect(database.connect).not.toHaveBeenCalled();
});

it("keeps the default read-only URLs for consumers that only import metadata", async () => {
  const { runtimeUrl } = await helper();
  expect(runtimeUrl).toBe(
    "postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54329/lyraseo_test",
  );
});

it("refuses implicit canonical fixture writes before opening a connection", async () => {
  const { seedTenants } = await helper();
  await expect(seedTenants()).rejects.toThrow(
    "OWNED_LOCAL_TEST_DATABASE_REQUIRED",
  );
  expect(database.connect).not.toHaveBeenCalled();
});

it.each([
  "",
  "lyraseo_test",
  "postgres",
  "template0",
  "lyraseo_disposable_migtest",
  "lyraseo_review_123bf4ff",
  "lyraseo_review_0123456789abc",
  "lyraseo_review_0123456789AB",
  "lyraseo_review_0123456789ab?host=remote.example",
  "lyraseo_review_0123456789ab/other",
  "lyraseo_review_0123456789ab\n",
  "lyraseo_review_0123456789ab;DROP DATABASE lyraseo_test",
])("rejects the non-owned database name %j", async (name) => {
  vi.stubEnv("LYRA_TEST_DB_NAME", name);
  await expect(helper()).rejects.toThrow("INVALID_LOCAL_TEST_DATABASE");
  expect(database.connect).not.toHaveBeenCalled();
});

it.each([
  "lyraseo_p2a1_0123456789ab",
  "lyraseo_p2a2_0123456789ab",
  "lyraseo_origin_0123456789ab",
  "lyraseo_agency_0123456789ab",
  "lyraseo_ledger_0123456789ab",
  "lyraseo_recovery_0123456789ab",
  "lyraseo_legacy_0123456789ab",
  "lyraseo_expiry_01234567",
  "lyraseo_expiry_0123456789ab",
  "lyraseo_review_0123456789ab",
])("resets only the explicitly selected owned name %s", async (name) => {
  vi.stubEnv("LYRA_TEST_DB_NAME", name);
  const { resetDatabase } = await helper();
  await resetDatabase();
  expect(database.connect).toHaveBeenCalledWith(
    `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
  );
  expect(database.execute).toHaveBeenCalledOnce();
  expect(database.disconnect).toHaveBeenCalledOnce();
});

it("uses only the validated disposable port and local restricted-role credentials", async () => {
  vi.stubEnv("LYRA_TEST_DB_NAME", "lyraseo_review_0123456789ab");
  vi.stubEnv("LYRA_TEST_DB_HOST_PORT", "54335");
  vi.stubEnv("LYRA_TEST_DB_ADMIN_PASSWORD", "lyraseo_disposable_123bf4ff");
  vi.stubEnv(
    "DATABASE_URL",
    "postgresql://admin:secret@remote.example/customer",
  );
  vi.stubEnv("DIRECT_URL", "postgresql://admin:secret@remote.example/customer");
  const { adminUrl, runtimeUrl, identityUrl } = await helper();
  expect([adminUrl, runtimeUrl, identityUrl]).toEqual([
    "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/lyraseo_review_0123456789ab",
    "postgresql://lyraseo_runtime:local_runtime_only@127.0.0.1:54335/lyraseo_review_0123456789ab",
    "postgresql://lyraseo_identity:local_identity_only@127.0.0.1:54335/lyraseo_review_0123456789ab",
  ]);
});

it.each([
  "",
  "0",
  "1023",
  "65536",
  "054335",
  "54335\n",
  "54335/other",
  "54335?host=remote",
  "remote:54335",
])(
  "rejects the malformed or non-user host port %j before connecting",
  async (port) => {
    vi.stubEnv("LYRA_TEST_DB_NAME", "lyraseo_ledger_0123456789ab");
    vi.stubEnv("LYRA_TEST_DB_HOST_PORT", port);
    await expect(helper()).rejects.toThrow("INVALID_LOCAL_TEST_DATABASE_PORT");
    expect(database.connect).not.toHaveBeenCalled();
  },
);

it.each([
  "",
  "short",
  "password@remote.example",
  "lyraseo_local_only\n",
  "lyraseo_local_only/other",
  "lyraseo_local_only?x=1",
  "x".repeat(129),
])(
  "rejects the malformed admin password %j before connecting",
  async (password) => {
    vi.stubEnv("LYRA_TEST_DB_NAME", "lyraseo_ledger_0123456789ab");
    vi.stubEnv("LYRA_TEST_DB_ADMIN_PASSWORD", password);
    await expect(helper()).rejects.toThrow(
      "INVALID_LOCAL_TEST_DATABASE_PASSWORD",
    );
    expect(database.connect).not.toHaveBeenCalled();
  },
);

it("does not redirect an imported helper when environment selection later changes", async () => {
  const { resetDatabase } = await helper();
  vi.stubEnv("LYRA_TEST_DB_NAME", "lyraseo_review_0123456789ab");
  await expect(resetDatabase()).rejects.toThrow(
    "OWNED_LOCAL_TEST_DATABASE_REQUIRED",
  );
  expect(database.connect).not.toHaveBeenCalled();
});

it("disconnects the owned admin connection even when truncation fails", async () => {
  vi.stubEnv("LYRA_TEST_DB_NAME", "lyraseo_ledger_0123456789ab");
  database.execute.mockRejectedValueOnce(new Error("fixture failure"));
  const { resetDatabase } = await helper();
  await expect(resetDatabase()).rejects.toThrow("fixture failure");
  expect(database.disconnect).toHaveBeenCalledOnce();
});

const runner = () => import("../../scripts/test-integration-owned.mjs");
const disposableName = "lyraseo-disposable-20261107-123bf4ff";
const containerId = "c".repeat(64);
function containerFixture() {
  return {
    Id: containerId,
    Name: `/${disposableName}`,
    Config: {
      Image: "postgres:17-alpine",
      Env: ["POSTGRES_PASSWORD=lyraseo_disposable_123bf4ff"],
    },
    State: { Running: true, Paused: false, Restarting: false },
    HostConfig: {
      NetworkMode: "bridge",
      Privileged: false,
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54335" }],
      },
    },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54335" }] },
    },
  };
}
const target = {
  hostPort: "54335",
  adminPassword: "lyraseo_disposable_123bf4ff",
};

it("pins the already-running validated disposable container by ID", async () => {
  const { integrationContainerId } = await runner();
  expect(
    integrationContainerId(containerFixture(), disposableName, target),
  ).toBe(containerId);
});

it.each([
  (c: ReturnType<typeof containerFixture>) => {
    c.Name = "/unrelated";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.Id = "name-not-id";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.Config.Image = "postgres:latest";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.Config.Env = ["POSTGRES_PASSWORD=wrong_password"];
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.Config.Env.push("POSTGRES_HOST_AUTH_METHOD=trust");
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.State.Running = false;
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.State.Paused = true;
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.State.Restarting = true;
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.HostConfig.NetworkMode = "host";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.HostConfig.Privileged = true;
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.HostConfig.PortBindings["5432/tcp"][0]!.HostIp = "0.0.0.0";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.HostConfig.PortBindings["5432/tcp"][0]!.HostPort = "54329";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.NetworkSettings.Ports["5432/tcp"][0]!.HostIp = "::";
  },
  (c: ReturnType<typeof containerFixture>) => {
    c.NetworkSettings.Ports["5432/tcp"].push({
      HostIp: "0.0.0.0",
      HostPort: "54335",
    });
  },
])("refuses unsafe container configuration mutation %#", async (mutate) => {
  const { integrationContainerId } = await runner();
  const container = containerFixture();
  mutate(container);
  expect(() =>
    integrationContainerId(container, disposableName, target),
  ).toThrow("UNSAFE_INTEGRATION_TEST_CONTAINER");
});

const server = {
  system_identifier: "7572951960123456789",
  started: "2026-11-07 10:00:00+00",
  port: 5432,
};
it.each([
  { ...server, system_identifier: "7572951960987654321" },
  { ...server, started: "2026-11-07 11:00:00+00" },
  { ...server, port: 54329 },
  {},
])(
  "refuses a host listener/postmaster identity mismatch %j",
  async (actual) => {
    const { assertSameIntegrationServer } = await runner();
    expect(() => assertSameIntegrationServer(server, actual)).toThrow(
      "INTEGRATION_TEST_SERVER_IDENTITY_MISMATCH",
    );
  },
);

it("refuses missing or elevated application roles rather than provisioning them", async () => {
  const { assertRestrictedIntegrationRoles } = await runner();
  expect(() => assertRestrictedIntegrationRoles([])).toThrow(
    "UNSAFE_INTEGRATION_TEST_ROLES",
  );
});

function roleFixtures() {
  const logins = [
    "anon",
    "authenticated",
    "lyraseo_runtime",
    "lyraseo_identity",
    "lyraseo_dispatch",
    "lyraseo_operator",
    "lyraseo_artifact_maintenance",
    "lyraseo_ledger_fixture",
    "lyraseo_billing_intake",
    "lyraseo_billing_reconciler",
    "lyraseo_staff_executor",
  ];
  const owners = [
    "lyraseo_kernel_owner",
    "lyraseo_expiry_owner",
    "lyraseo_legacy_visibility_owner",
    "lyraseo_ledger_owner",
    "lyraseo_staff_job_owner",
    "lyraseo_billing_owner",
    "lyraseo_history_owner",
    "lyraseo_deletion_owner",
    "lyraseo_handoff_owner",
    "lyraseo_report_owner",
    "lyraseo_legacy_inline_owner",
  ];
  return [...logins, ...owners].map((rolname) => ({
    rolname,
    rolcanlogin: logins.includes(rolname),
    rolsuper: false,
    rolbypassrls: false,
    rolinherit: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    memberships: 0,
    owns_database: false,
  }));
}

it("accepts existing restricted login and NOLOGIN purpose roles without repair", async () => {
  const { assertRestrictedIntegrationRoles } = await runner();
  expect(() => assertRestrictedIntegrationRoles(roleFixtures())).not.toThrow();
});

it.each([
  "rolsuper",
  "rolbypassrls",
  "rolinherit",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "owns_database",
] as const)(
  "refuses runtime authority escalation through %s",
  async (attribute) => {
    const { assertRestrictedIntegrationRoles } = await runner();
    const roles = roleFixtures();
    roles.find((role) => role.rolname === "lyraseo_runtime")![attribute] = true;
    expect(() => assertRestrictedIntegrationRoles(roles)).toThrow(
      "UNSAFE_INTEGRATION_TEST_ROLES",
    );
  },
);

it("refuses role membership even for NOINHERIT roles", async () => {
  const { assertRestrictedIntegrationRoles } = await runner();
  const roles = roleFixtures();
  roles[0]!.memberships = 1;
  expect(() => assertRestrictedIntegrationRoles(roles)).toThrow(
    "UNSAFE_INTEGRATION_TEST_ROLES",
  );
});

it("refuses login-enabled purpose owners", async () => {
  const { assertRestrictedIntegrationRoles } = await runner();
  const roles = roleFixtures();
  roles.find((role) => role.rolname === "lyraseo_report_owner")!.rolcanlogin =
    true;
  expect(() => assertRestrictedIntegrationRoles(roles)).toThrow(
    "UNSAFE_INTEGRATION_TEST_ROLES",
  );
});

function fixtureProcesses(failure?: "create" | "vitest") {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const queries: Array<{ db: string; sql: string }> = [];
  spawn.mockImplementation(
    (command: string, args: string[], options: { input?: string }) => {
      const result = { status: 0, stdout: "", stderr: "", signal: null };
      if (command === "docker" && args[0] === "inspect")
        return { ...result, stdout: JSON.stringify([containerFixture()]) };
      if (command === process.execPath)
        return { ...result, stdout: JSON.stringify(server) };
      if (command === "pnpm") {
        if (args.includes("vitest"))
          return {
            ...result,
            status: failure === "vitest" ? 19 : 0,
            stdout: "raw vitest output\n",
            stderr: "raw vitest stderr\n",
          };
        return result;
      }
      if (command !== "docker" || args[0] !== "exec" || !args.includes("psql"))
        throw Error("UNEXPECTED_PROCESS_IN_TEST");
      const sql = options.input!;
      queries.push({ db: args[args.indexOf("-d") + 1]!, sql });
      if (sql.startsWith("CREATE DATABASE") && failure === "create")
        return { ...result, status: 9, stderr: "database already exists\n" };
      if (sql.includes("pg_control_system()"))
        return { ...result, stdout: JSON.stringify(server) };
      if (sql.includes("FROM pg_roles r"))
        return { ...result, stdout: JSON.stringify(roleFixtures()) };
      if (sql.includes("json_build_object('oid'"))
        return {
          ...result,
          stdout: '{"oid" : "12345", "owner" : "postgres"}\n',
        };
      return result;
    },
  );
  return queries;
}

const fixtureEnvironment = {
  LYRA_TEST_DB_CONTAINER: disposableName,
  LYRA_TEST_DB_HOST_PORT: "54335",
  LYRA_TEST_DB_ADMIN_PASSWORD: "lyraseo_disposable_123bf4ff",
};

it("creates template0, migrates, grants, runs raw vitest and drops only its successfully created database", async () => {
  const { runOwnedIntegration } = await runner();
  const queries = fixtureProcesses();
  const result = runOwnedIntegration({
    ...fixtureEnvironment,
    LYRA_TEST_DB_NAME: "lyraseo_test",
    PGHOSTADDR: "remote.example",
    DIRECT_URL: "postgresql://remote/customer",
  });
  fixtureReceipts.push(result.receipts);
  expect(result).toMatchObject({
    created: true,
    dropped: true,
    passed: true,
    exitCode: 0,
  });
  expect(
    queries.find((query) => query.sql.startsWith("CREATE DATABASE"))?.sql,
  ).toBe(`CREATE DATABASE "${result.databaseName}" TEMPLATE template0;`);
  expect(queries.at(-1)?.sql).toBe(`DROP DATABASE "${result.databaseName}";`);
  const processes = spawn.mock.calls.filter(([command]) => command === "pnpm");
  expect(processes.map(([, args]) => args)).toEqual([
    ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
    ["exec", "vitest", "run", "tests/integration"],
  ]);
  expect(processes[0]![2].env).toMatchObject({
    LYRA_TEST_DB_NAME: result.databaseName,
    LYRA_TEST_DB_HOST_PORT: "54335",
    LYRA_TEST_DB_ADMIN_PASSWORD: fixtureEnvironment.LYRA_TEST_DB_ADMIN_PASSWORD,
  });
  expect(processes[0]![2].env.PGHOSTADDR).toBeUndefined();
  expect(
    queries.every(
      (query) => query.db === "postgres" || query.db === result.databaseName,
    ),
  ).toBe(true);
  expect(
    spawn.mock.calls.filter(
      ([command, args]) =>
        command === "docker" && !["inspect", "exec"].includes(args[0]),
    ),
  ).toEqual([]);
});

it.each(["create", "vitest"] as const)(
  "preserves raw %s failure exit and never drops a failed/unowned database",
  async (failure) => {
    const { runOwnedIntegration } = await runner();
    const queries = fixtureProcesses(failure);
    let error: { exitCode?: number; receipts?: string } | undefined;
    try {
      runOwnedIntegration(fixtureEnvironment);
    } catch (caught) {
      error = caught as typeof error;
    }
    if (error?.receipts) fixtureReceipts.push(error.receipts);
    expect(error?.exitCode).toBe(failure === "create" ? 9 : 19);
    expect(queries.some((query) => query.sql.startsWith("DROP DATABASE"))).toBe(
      false,
    );
    const summary = JSON.parse(
      readFileSync(join(error!.receipts!, "summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      created: failure !== "create",
      dropped: false,
      passed: false,
      exitCode: error!.exitCode,
    });
    if (failure === "vitest") {
      const receipt = readdirSync(error!.receipts!).find((path) =>
        path.endsWith("-vitest.stdout.log"),
      )!;
      expect(readFileSync(join(error!.receipts!, receipt), "utf8")).toBe(
        "raw vitest output\n",
      );
      expect(
        readFileSync(
          join(error!.receipts!, receipt.replace("stdout", "stderr")),
          "utf8",
        ),
      ).toBe("raw vitest stderr\n");
    }
  },
);

it("rejects other dedicated gate database overrides before issuing any command", async () => {
  const { runOwnedIntegration } = await runner();
  expect(() =>
    runOwnedIntegration({
      ...fixtureEnvironment,
      LYRA_REPORT_GATE_URL: "postgresql://remote/customer",
    }),
  ).toThrow("DEDICATED_INTEGRATION_DATABASE_OVERRIDE_FORBIDDEN");
  expect(spawn).not.toHaveBeenCalled();
});
