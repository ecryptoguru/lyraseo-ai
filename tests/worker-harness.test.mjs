import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTestMapper,
  readIssuedPins,
  writeIssuedPins,
} from "../scripts/lib/worker-test-mapper.mjs";
import {
  runWorkerBridge,
  workerDatabaseTarget,
} from "../scripts/test-worker-bridge.mjs";
const bridge = "http://127.0.0.1:42001",
  control = "http://127.0.0.1:42002";
const issued = { version: 1, bridge, control };
const path = "/api/internal/runtime/dispatch";
const disposableEnvironment = {
  LYRA_BACKUP_TEST_CONTAINER: "lyraseo-disposable-20261107-123bf4ff",
  LYRA_BACKUP_TEST_PORT: "54335",
  LYRA_BACKUP_TEST_ADMIN_PASSWORD: "lyraseo_disposable_123bf4ff",
};
const containerId = "c".repeat(64);
function inspectedContainer() {
  return {
    Id: containerId,
    Name: "/lyraseo-phase1-postgres",
    Config: { Image: "postgres:17-alpine" },
    State: { Running: true },
    HostConfig: {
      PortBindings: {
        "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }],
      },
    },
    NetworkSettings: {
      Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
    },
  };
}
function disposableContainer() {
  const inspected = inspectedContainer();
  inspected.Name = "/lyraseo-disposable-20261107-123bf4ff";
  inspected.HostConfig.PortBindings["5432/tcp"][0].HostPort = "54335";
  inspected.NetworkSettings.Ports["5432/tcp"][0].HostPort = "54335";
  return inspected;
}
function fixture(overrides = {}) {
  const calls = [];
  let pins = { ...issued };
  const mapper = createTestMapper({
    bridgeOrigin: bridge,
    controlOrigin: control,
    readPins: () => pins,
    transport: async (...args) => {
      calls.push(args);
      return Response.json({ disposition: "OK", refs: [] });
    },
    ...overrides,
  });
  return { mapper, calls, setPins: (value) => (pins = value) };
}
for (const candidate of [
  "https://other.invalid",
  "http://localhost:42001",
  "http://127.0.0.1:42003",
  "http://127.0.0.1:42001/extra",
  "http://user@127.0.0.1:42001",
  "http://127.0.0.1:42001?x=1",
  "http://127.0.0.1:42001/",
  undefined,
])
  test(`round1 mapper rejects unissued bridge ${String(candidate)}`, async () => {
    const { mapper, calls } = fixture({ bridgeOrigin: candidate });
    await assert.rejects(() =>
      mapper(
        new Request("https://bridge.test.invalid" + path, {
          method: "POST",
          body: "{}",
        }),
      ),
    );
    assert.equal(calls.length, 0);
  });
for (const candidate of [
  "https://other.invalid",
  "http://127.0.0.1:42003",
  "http://127.0.0.1:42002/path",
  "http://user@127.0.0.1:42002",
  undefined,
])
  test(`round1 mapper rejects unissued control ${String(candidate)}`, async () => {
    const { mapper, calls } = fixture({ controlOrigin: candidate });
    await assert.rejects(() =>
      mapper(new Request("https://harness.test.invalid/state")),
    );
    assert.equal(calls.length, 0);
  });
for (const [url, method] of [
  ["https://bridge.test.invalid" + path, "GET"],
  ["https://bridge.test.invalid/api/internal/runtime/dispatch/", "POST"],
  ["https://bridge.test.invalid/api/internal/runtime/unknown", "POST"],
  ["https://bridge.test.invalid" + path + "?x=1", "POST"],
  ["https://bridge.test.invalid" + path + "?", "POST"],
  ["https://harness.test.invalid/state?", "GET"],
  ["https://harness.test.invalid/state", "POST"],
  ["https://harness.test.invalid/unknown", "GET"],
])
  test(`round1 mapper literal path/method ${method} ${url}`, async () => {
    const { mapper, calls } = fixture();
    await assert.rejects(() =>
      mapper(
        new Request(url, {
          method,
          body: method === "POST" ? "{}" : undefined,
        }),
      ),
    );
    assert.equal(calls.length, 0);
  });
test("round1 mapper rejects redirects without following them", async () => {
  const calls = [];
  const { mapper } = fixture({
    transport: async (target) => {
      calls.push(target);
      return new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1:42003" },
      });
    },
  });
  await assert.rejects(() =>
    mapper(new Request("https://harness.test.invalid/restart")),
  );
  assert.deepEqual(calls, [control + "/restart"]);
});
for (const origin of [
  "https://offhost.invalid",
  "http://127.0.0.1:42003",
  "http://127.0.0.1:42001/path",
  "http://user@127.0.0.1:42003",
])
  test(`round1 restart cannot install unissued endpoint ${origin}`, async () => {
    const calls = [];
    const { mapper } = fixture({
      transport: async (target) => {
        calls.push(target);
        return Response.json({ origin });
      },
    });
    await assert.rejects(() =>
      mapper(new Request("https://harness.test.invalid/restart")),
    );
    assert.deepEqual(calls, [control + "/restart"]);
  });
test("round1 failed CREATE does not drop candidate database", async () => {
  const commands = [];
  await assert.rejects(() =>
    runWorkerBridge({
      environment: {},
      command: (_cmd, args, options) => {
        commands.push({ args, input: options?.input });
        if (args[0] === "inspect")
          return {
            status: 0,
            stdout: JSON.stringify([inspectedContainer()]),
          };
        if (options?.input?.startsWith("CREATE DATABASE")) return { status: 1 };
        return { status: 0 };
      },
    }),
  );
  assert.equal(
    commands.filter((x) => x.input?.startsWith("DROP DATABASE")).length,
    0,
  );
});
test("round1 issued restart requires next version and independent matching pin", async () => {
  let pins = { ...issued };
  const calls = [];
  const mapper = createTestMapper({
    bridgeOrigin: bridge,
    controlOrigin: control,
    readPins: () => pins,
    transport: async (target) => {
      calls.push(target);
      if (target === control + "/restart") {
        pins = { ...pins, bridge: "http://127.0.0.1:42004", version: 2 };
        return Response.json({ origin: pins.bridge, version: pins.version });
      }
      return Response.json({ disposition: "OK", refs: [] });
    },
  });
  await mapper(new Request("https://harness.test.invalid/restart"));
  await mapper(
    new Request("https://bridge.test.invalid" + path, {
      method: "POST",
      body: "{}",
    }),
  );
  assert.deepEqual(calls, [
    control + "/restart",
    "http://127.0.0.1:42004" + path,
  ]);
});
for (const variant of [
  "old-version",
  "skipped-version",
  "control-changed",
  "extra-property",
  "oversized",
])
  test(`round1 rejects restart authority ${variant}`, async () => {
    let pins = { ...issued };
    let calls = 0;
    const mapper = createTestMapper({
      bridgeOrigin: bridge,
      controlOrigin: control,
      readPins: () => pins,
      transport: async () => {
        calls++;
        pins = {
          ...issued,
          bridge: "http://127.0.0.1:42004",
          version:
            variant === "old-version"
              ? 1
              : variant === "skipped-version"
                ? 3
                : 2,
        };
        if (variant === "control-changed")
          pins.control = "http://127.0.0.1:42005";
        return Response.json({
          origin: pins.bridge,
          version: pins.version,
          ...(variant === "extra-property"
            ? { extra: 1 }
            : variant === "oversized"
              ? { padding: "a".repeat(4097) }
              : {}),
        });
      },
    });
    await assert.rejects(() =>
      mapper(new Request("https://harness.test.invalid/restart")),
    );
    assert.equal(calls, 1);
  });
test("round1 mapper preserves signed bytes and only explicit fixed paths", async () => {
  const calls = [];
  const mapper = createTestMapper({
    bridgeOrigin: bridge,
    controlOrigin: control,
    readPins: () => issued,
    transport: async (target, options) => {
      calls.push({ target, options });
      return Response.json({ disposition: "OK", refs: [] });
    },
  });
  const raw = ' {"limit":1} ';
  await mapper(
    new Request("https://bridge.test.invalid" + path, {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "application/json",
        "x-lyra-signature": "synthetic-signature",
      },
    }),
  );
  assert.equal(calls[0].target, bridge + path);
  assert.equal(Buffer.from(calls[0].options.body).toString(), raw);
  assert.equal(
    calls[0].options.headers.get("x-lyra-signature"),
    "synthetic-signature",
  );
  assert.equal(calls[0].options.headers.has("host"), false);
  assert.equal(calls[0].options.redirect, "manual");
});

test("round1 private issued pin file is bounded and excludes unknown fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "lyraseo-worker-pins-test-"));
  const path = join(directory, "pins.json");
  try {
    writeIssuedPins(path, issued);
    assert.deepEqual(readIssuedPins(path), issued);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    writeFileSync(path, " ".repeat(4097));
    assert.throws(() => readIssuedPins(path));
    assert.throws(() => writeIssuedPins(path, { ...issued, unexpected: true }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("round2 POST body barrier cannot forward a retired pin after authorized restart", async () => {
  let pins = { ...issued };
  const calls = [];
  const mapper = createTestMapper({
    bridgeOrigin: bridge,
    controlOrigin: control,
    readPins: () => pins,
    transport: async (target) => {
      calls.push(target);
      if (target === control + "/restart") {
        pins = { ...issued, version: 2, bridge: "http://127.0.0.1:42004" };
        return Response.json({ origin: pins.bridge, version: pins.version });
      }
      return Response.json({ disposition: "OK", refs: [] });
    },
  });
  let started;
  const reading = new Promise((resolve) => (started = resolve));
  let controller;
  const body = new ReadableStream(
    {
      start(value) {
        controller = value;
      },
      pull() {
        started();
      },
    },
    { highWaterMark: 0 },
  );
  const blocked = mapper(
    new Request("https://bridge.test.invalid" + path, {
      method: "POST",
      body,
      duplex: "half",
      headers: { "x-lyra-signature": "synthetic-only" },
    }),
  ).then(
    () => false,
    (error) => error.message === "TEST_AUTHORITY_CHANGED",
  );
  await reading;
  await mapper(new Request("https://harness.test.invalid/restart"));
  controller.enqueue(new TextEncoder().encode("{}"));
  controller.close();
  assert.equal(await blocked, true);
  assert.deepEqual(calls, [control + "/restart"]);
});
for (const kind of ["non-ok", "encoded", "wrong-content-type"])
  test(`round2 rejected restart ${kind} cancels nonending body without pin update`, async () => {
    let cancelled = false;
    const calls = [];
    const mapper = createTestMapper({
      bridgeOrigin: bridge,
      controlOrigin: control,
      readPins: () => issued,
      transport: async (target) => {
        calls.push(target);
        return target === control + "/restart"
          ? new Response(
              new ReadableStream({
                cancel() {
                  cancelled = true;
                },
              }),
              {
                status: kind === "non-ok" ? 503 : 200,
                headers: {
                  "content-type":
                    kind === "wrong-content-type"
                      ? "text/plain"
                      : "application/json",
                  ...(kind === "encoded" ? { "content-encoding": "gzip" } : {}),
                },
              },
            )
          : Response.json({ disposition: "OK", refs: [] });
      },
    });
    await assert.rejects(
      () => mapper(new Request("https://harness.test.invalid/restart")),
      /INVALID_RESTART_REPLY/,
    );
    assert.equal(cancelled, true);
    await mapper(
      new Request("https://bridge.test.invalid" + path, {
        method: "POST",
        body: "{}",
      }),
    );
    assert.deepEqual(calls, [control + "/restart", bridge + path]);
  });
function simulatedSupervisor(
  failure,
  environment = {},
  inspected = inspectedContainer(),
) {
  const commands = [],
    terminated = [],
    directories = [],
    escaped = [],
    children = [],
    configurations = [];
  let publications = 0;
  const child = (pid) => {
    const value = new EventEmitter();
    value.pid = pid;
    value.exitCode = null;
    value.signalCode = null;
    children.push(value);
    return value;
  };
  const listener = child(62001);
  let tests;
  const finish = (value, signal = null) => {
    if (value.exitCode !== null || value.signalCode !== null) return;
    value.exitCode = signal ? null : 0;
    value.signalCode = signal;
    value.emit("exit", value.exitCode, signal);
  };
  const dispatch = (message) => {
    try {
      listener.emit("message", message);
    } catch (error) {
      escaped.push(error.message);
      if (tests) finish(tests);
      else listener.emit("error", error);
    }
  };
  listener.send = (message, callback) => {
    if (message.secret) configurations.push(message);
    if (failure === "configure-send" && message.secret)
      throw Error("INJECTED_IPC_FAILURE");
    if (failure === "configure-async-send" && message.secret) {
      setImmediate(() => {
        if (callback) callback(Error("INJECTED_IPC_FAILURE"));
        else listener.emit("error", Error("INJECTED_IPC_FAILURE"));
      });
      return true;
    }
    if (message.secret)
      setImmediate(() =>
        dispatch({
          event: "ready",
          origin:
            failure === "startup-authorization"
              ? "https://unissued.invalid"
              : bridge,
          control,
        }),
      );
    if (message.event === "restart-pinned") {
      if (failure === "restart-reply") throw Error("INJECTED_IPC_FAILURE");
      if (failure === "restart-async-reply")
        setImmediate(() => {
          if (callback) callback(Error("INJECTED_IPC_FAILURE"));
          else {
            listener.emit("error", Error("INJECTED_IPC_FAILURE"));
            finish(tests);
          }
        });
      else callback?.(null);
    } else callback?.(null);
    return true;
  };
  const options = {
    environment,
    command: (command, args, settings) => {
      commands.push({
        command,
        args,
        input: settings?.input,
        env: settings?.env,
      });
      if (args[0] === "inspect")
        return {
          status: 0,
          stdout: JSON.stringify([inspected]),
        };
      return { status: 0 };
    },
    makePinDirectory: (prefix) => {
      const directory = mkdtempSync(prefix);
      directories.push(directory);
      return directory;
    },
    publishPins: (path, pins) => {
      publications++;
      if (
        (failure === "startup-publication" && publications === 1) ||
        (failure === "restart-publication" && publications === 2)
      )
        throw Error("INJECTED_PIN_FAILURE");
      writeIssuedPins(path, pins);
    },
    forkProcess: (_cli, _args, settings) => {
      commands.push({ command: "fork", args: [], env: settings.env });
      setImmediate(() => dispatch({ event: "configure" }));
      return listener;
    },
    spawnProcess: () => {
      tests = child(62002);
      if (failure === "success") {
        setImmediate(() => finish(tests));
        return tests;
      }
      if (failure === "test-exit") {
        setImmediate(() => {
          tests.exitCode = 19;
          tests.emit("exit", 19, null);
        });
        return tests;
      }
      setImmediate(() =>
        dispatch({
          event: "restart-pin",
          origin:
            failure === "restart-authorization"
              ? "https://unissued.invalid"
              : "http://127.0.0.1:42004",
        }),
      );
      return tests;
    },
    terminateGroup: (pid, signal) => {
      terminated.push({ pid, signal });
      const value = children.find((child) => child.pid === pid);
      if (value) finish(value, signal);
    },
  };
  return {
    options,
    commands,
    terminated,
    directories,
    escaped,
    children,
    configurations,
  };
}
for (const failure of [
  "startup-authorization",
  "startup-publication",
  "configure-send",
  "configure-async-send",
  "restart-authorization",
  "restart-publication",
  "restart-reply",
  "restart-async-reply",
])
  test(`round2 awaited supervisor failure and owned cleanup ${failure}`, async () => {
    const signalListeners = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    const fixture = simulatedSupervisor(failure);
    let rejected = false;
    try {
      await runWorkerBridge(fixture.options);
    } catch (error) {
      rejected =
        /INVALID_TEST_ENDPOINT|INJECTED_PIN_FAILURE|INJECTED_IPC_FAILURE/.test(
          error.message,
        );
    }
    assert.equal(rejected, true);
    assert.deepEqual(fixture.escaped, []);
    assert.deepEqual(
      [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")],
      signalListeners,
    );
    const created = fixture.commands
      .filter((command) => command.input?.startsWith("CREATE DATABASE"))
      .map((command) => command.input.match(/^CREATE DATABASE (\w+)/)[1]);
    const dropped = fixture.commands
      .filter((command) => command.input?.startsWith("DROP DATABASE"))
      .map((command) => command.input);
    assert.equal(created.length, 1);
    assert.deepEqual(dropped, []);
    assert.equal(fixture.directories.length, 1);
    for (const directory of fixture.directories)
      assert.equal(existsSync(directory), true);
    for (const child of fixture.children) {
      assert.equal(
        fixture.terminated.some(
          (entry) => entry.pid === child.pid && entry.signal === "SIGTERM",
        ),
        true,
      );
      assert.equal(child.listenerCount("message"), 0);
      assert.equal(child.listenerCount("error"), 0);
      assert.equal(child.listenerCount("exit"), 0);
    }
    for (const directory of fixture.directories)
      rmSync(directory, { recursive: true, force: true });
  });

test("worker bridge selects the approved disposable endpoint and never falls back to shared defaults", async () => {
  const fixture = simulatedSupervisor(
    "configure-send",
    disposableEnvironment,
    disposableContainer(),
  );
  try {
    await assert.rejects(
      () => runWorkerBridge(fixture.options),
      /INJECTED_IPC_FAILURE/,
    );
    assert.equal(
      fixture.commands[0].args.at(-1),
      "lyraseo-disposable-20261107-123bf4ff",
    );
    assert.equal(
      fixture.commands
        .filter((entry) => entry.args[0] === "exec")
        .every((entry) => entry.args.includes(containerId)),
      true,
    );
    const admin = fixture.configurations[0].admin;
    assert.match(
      admin,
      /^postgresql:\/\/postgres:lyraseo_disposable_123bf4ff@127\.0\.0\.1:54335\/lyraseo_worker_[a-f0-9]{32}$/,
    );
    assert.equal(
      fixture.commands.find((entry) => entry.command === "pnpm").env.DIRECT_URL,
      admin,
    );
    assert.equal(
      fixture.commands.find((entry) => entry.command === "fork").env
        .LYRA_BACKUP_TEST_PORT,
      "54335",
    );
    assert.equal(
      fixture.commands.filter((entry) =>
        entry.input?.startsWith("DROP DATABASE"),
      ).length,
      0,
    );
  } finally {
    for (const directory of fixture.directories)
      rmSync(directory, { recursive: true, force: true });
  }
});

for (const unsafe of [
  "stopped",
  "runtime-binding",
  "configured-binding",
  "wrong-id",
]) {
  test(`worker bridge refuses ${unsafe} before creating a database`, async () => {
    const inspected = inspectedContainer();
    if (unsafe === "stopped") inspected.State.Running = false;
    if (unsafe === "runtime-binding")
      inspected.NetworkSettings.Ports["5432/tcp"][0].HostIp = "0.0.0.0";
    if (unsafe === "configured-binding")
      inspected.HostConfig.PortBindings["5432/tcp"][0].HostIp = "0.0.0.0";
    if (unsafe === "wrong-id") inspected.Id = "not-a-container-id";
    const fixture = simulatedSupervisor("configure-send", {}, inspected);
    try {
      await assert.rejects(
        () => runWorkerBridge(fixture.options),
        /Unexpected disposable DB container/,
      );
      assert.equal(
        fixture.commands.some((entry) =>
          entry.input?.startsWith("CREATE DATABASE"),
        ),
        false,
      );
    } finally {
      for (const directory of fixture.directories)
        rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("worker bridge preserves a raw child failure exit and retains its owned database", async () => {
  const fixture = simulatedSupervisor("test-exit");
  try {
    await assert.rejects(
      () => runWorkerBridge(fixture.options),
      (error) => error.exitCode === 19,
    );
    assert.equal(
      fixture.commands.some((entry) =>
        entry.input?.startsWith("DROP DATABASE"),
      ),
      false,
    );
  } finally {
    for (const directory of fixture.directories)
      rmSync(directory, { recursive: true, force: true });
  }
});

test("successful worker bridge owns a template0 database and cleans only that resource", async () => {
  const fixture = simulatedSupervisor("success");
  try {
    await runWorkerBridge(fixture.options);
    const created = fixture.commands.find((entry) =>
      entry.input?.startsWith("CREATE DATABASE"),
    ).input;
    assert.match(
      created,
      /^CREATE DATABASE lyraseo_worker_[a-f0-9]{32} TEMPLATE template0$/,
    );
    const name = created.match(/^CREATE DATABASE (\w+)/)[1];
    assert.deepEqual(
      fixture.commands
        .filter((entry) => entry.input?.startsWith("DROP DATABASE"))
        .map((entry) => entry.input),
      [`DROP DATABASE ${name}`],
    );
    assert.equal(
      fixture.directories.every((directory) => !existsSync(directory)),
      true,
    );
  } finally {
    for (const directory of fixture.directories)
      rmSync(directory, { recursive: true, force: true });
  }
});

test("supervisor accepts only the environment-selected local port and owned worker database", () => {
  const name = "lyraseo_worker_" + "a".repeat(32);
  assert.equal(
    workerDatabaseTarget(
      `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
      {},
    ).port,
    "54329",
  );
  const parsed = workerDatabaseTarget(
    `postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/${name}`,
    disposableEnvironment,
  );
  assert.equal(parsed.port, "54335");
  assert.equal(parsed.pathname, "/" + name);
  assert.throws(
    () =>
      workerDatabaseTarget(
        `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${name}`,
        disposableEnvironment,
      ),
    /OWNED_DISPOSABLE_DATABASE_REQUIRED/,
  );
});

for (const candidate of [
  "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/lyraseo_test",
  "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54336/lyraseo_worker_" +
    "a".repeat(32),
  "postgresql://postgres:lyraseo_disposable_123bf4ff@remote.invalid:54335/lyraseo_worker_" +
    "a".repeat(32),
  "postgresql://postgres:lyraseo_disposable_123bf4ff@localhost:54335/lyraseo_worker_" +
    "a".repeat(32),
  "postgresql://lyraseo_dispatch:local_dispatch_only@127.0.0.1:54335/lyraseo_worker_" +
    "a".repeat(32),
  "postgresql://postgres:wrong_admin_password@127.0.0.1:54335/lyraseo_worker_" +
    "a".repeat(32),
  "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/lyraseo_worker_" +
    "a".repeat(32) +
    "?host=remote.invalid",
  "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/lyraseo_worker_" +
    "a".repeat(32) +
    "#fragment",
  "postgresql://postgres:lyraseo_disposable_123bf4ff@127.0.0.1:54335/lyraseo_worker_" +
    "a".repeat(31),
]) {
  test(`supervisor rejects unowned/redirected database target ${candidate.replace(/:[^:@/]+@/, ":<redacted>@")}`, () => {
    assert.throws(
      () => workerDatabaseTarget(candidate, disposableEnvironment),
      /OWNED_DISPOSABLE_DATABASE_REQUIRED/,
    );
  });
}
