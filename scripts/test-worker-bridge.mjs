// Owns only a random disposable database in the validated local harness.
import { spawn, spawnSync, fork } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { loopbackOrigin, writeIssuedPins } from "./lib/worker-test-mapper.mjs";
import { backupTestTarget } from "./lib/backup-test-target.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inspectFormat =
  '[{"Id":{{json .Id}},"Name":{{json .Name}},"Config":{"Image":{{json .Config.Image}}},"State":{"Running":{{json .State.Running}}},"HostConfig":{"PortBindings":{{json .HostConfig.PortBindings}}},"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}}}]';

export function workerDatabaseTarget(adminUrl, environment = process.env) {
  const selected = backupTestTarget(environment);
  const parsed = new URL(adminUrl);
  if (
    /[\r\n\t]/.test(adminUrl) ||
    parsed.protocol !== "postgresql:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== String(selected.port) ||
    parsed.username !== "postgres" ||
    decodeURIComponent(parsed.password) !== selected.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/lyraseo_worker_[0-9a-f]{32}$/.test(parsed.pathname)
  )
    throw Error("OWNED_DISPOSABLE_DATABASE_REQUIRED");
  return parsed;
}

export async function runWorkerBridge({
  environment = process.env,
  command = spawnSync,
  testArgs = [],
  forkProcess = fork,
  spawnProcess = spawn,
  publishPins = writeIssuedPins,
  makePinDirectory = mkdtempSync,
  terminateGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  const selected = backupTestTarget(environment);
  const env = { ...environment };
  for (const key of Object.keys(env)) if (key.startsWith("PG")) delete env[key];
  function run(cmd, args, options = {}) {
    const result = command(cmd, args, {
      cwd: root,
      env,
      stdio: "inherit",
      ...options,
    });
    if (result.error || result.status !== 0)
      throw Object.assign(Error(`Worker harness command failed: ${cmd}`), {
        exitCode: result.status ?? 1,
      });
    return result;
  }
  const inspected = JSON.parse(
    run("docker", ["inspect", "--format", inspectFormat, selected.container], {
      encoding: "utf8",
      stdio: "pipe",
    }).stdout,
  )[0];
  const validBinding = (bindings) =>
    Object.keys(bindings ?? {}).length === 1 &&
    bindings["5432/tcp"]?.length === 1 &&
    bindings["5432/tcp"][0].HostIp === "127.0.0.1" &&
    bindings["5432/tcp"][0].HostPort === String(selected.port);
  if (
    !/^[a-f0-9]{64}$/.test(inspected.Id ?? "") ||
    inspected.Name !== "/" + selected.container ||
    inspected.Config.Image !== "postgres:17-alpine" ||
    inspected.State?.Running !== true ||
    !validBinding(inspected.HostConfig?.PortBindings) ||
    !validBinding(inspected.NetworkSettings?.Ports)
  )
    throw Error("Unexpected disposable DB container");
  const container = inspected.Id;
  const database = "lyraseo_worker_" + randomUUID().replaceAll("-", "");
  const sql = (statement) =>
    run(
      "docker",
      [
        "exec",
        "-i",
        "--env",
        "PGPASSWORD",
        container,
        "psql",
        "-X",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
      ],
      {
        input: statement,
        stdio: ["pipe", "inherit", "inherit"],
        env: { ...env, PGPASSWORD: selected.password },
      },
    );
  let listener, tests;
  let disposeSupervision = () => {};
  let ownsDatabase = false,
    passed = false,
    pinDirectory,
    pinPath,
    pins;
  let cleaning;
  const cleanup = () =>
    (cleaning ??= (async () => {
      disposeSupervision();
      try {
        for (const child of [tests, listener]) {
          if (!child?.pid) continue;
          const stopGroup = (signal) => {
            try {
              terminateGroup(child.pid, signal);
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          };
          stopGroup("SIGTERM");
          if (child.exitCode === null && child.signalCode === null) {
            await new Promise((resolve) => {
              const timer = setTimeout(() => {
                stopGroup("SIGKILL");
                resolve();
              }, 3000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          stopGroup("SIGKILL");
        }
        if (ownsDatabase && passed) {
          sql(`DROP DATABASE ${database}`);
          ownsDatabase = false;
          console.log(`Successful owned worker database removed: ${database}`);
        }
      } finally {
        if (pinDirectory && passed && !ownsDatabase)
          rmSync(pinDirectory, { recursive: true, force: true });
        if (ownsDatabase)
          console.error(
            `Retained failed owned worker database: ${database}; evidence: ${pinDirectory ?? "no pin directory created"}`,
          );
      }
    })());
  const signalHandlers = [];
  for (const [signal, status] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      void cleanup().finally(() => process.exit(status));
    };
    signalHandlers.push([signal, handler]);
    process.once(signal, handler);
  }
  try {
    console.log(
      `Reserved disposable database ${database}; canonical lyraseo_test is untouched.`,
    );
    sql(`CREATE DATABASE ${database} TEMPLATE template0`);
    ownsDatabase = true;
    mkdirSync(resolve(root, "tmp"), { recursive: true });
    pinDirectory = makePinDirectory(resolve(root, "tmp/worker-carrier-"));
    pinPath = resolve(pinDirectory, "issued-pins.json");
    const admin = `postgresql://postgres:${encodeURIComponent(selected.password)}@127.0.0.1:${selected.port}/${database}`;
    workerDatabaseTarget(admin, environment);
    run(
      "pnpm",
      ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...env, DIRECT_URL: admin } },
    );
    run(
      "docker",
      [
        "exec",
        "-i",
        "--env",
        "PGPASSWORD",
        container,
        "psql",
        "-X",
        "-h",
        "127.0.0.1",
        "-p",
        "5432",
        "-U",
        "postgres",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
      ],
      {
        env: { ...env, PGPASSWORD: selected.password },
        input:
          "INSERT INTO lyraseo_kernel.test_environment(database_oid,postmaster_started_at) SELECT oid,pg_catalog.pg_postmaster_start_time() FROM pg_database WHERE datname=current_database();",
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    const require = createRequire(import.meta.url);
    const cli = resolve(
      dirname(
        require.resolve("vite-node/package.json", {
          paths: [dirname(require.resolve("vitest/package.json"))],
        }),
      ),
      "vite-node.mjs",
    );
    // A resolving failure latch stays live across startup and test execution.
    // EventEmitter callbacks never throw/reject outside the runner's await path.
    let failureError, resolveFailure, startupTimer;
    const failures = new Promise((resolve) => {
      resolveFailure = resolve;
    });
    const fail = (error) => {
      if (failureError) return;
      failureError =
        error instanceof Error ? error : Error("SUPERVISOR_FAILURE");
      clearTimeout(startupTimer);
      resolveFailure({ error: failureError });
    };
    const untilFailure = async (promise) => {
      const result = await Promise.race([
        promise.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
        failures,
      ]);
      if (Object.hasOwn(result, "error")) throw result.error;
      return result.value;
    };
    listener = forkProcess(
      cli,
      ["tests/fixtures/runtime/worker-supervisor.ts"],
      {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      },
    );
    const secret = randomBytes(32).toString("base64url");
    const rotatedSecret = randomBytes(32).toString("base64url");
    let resolveReady, onTestError, onTestExit;
    const readyPromise = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const send = (message) =>
      listener.send(message, (error) => {
        if (error) fail(error);
      });
    const onMessage = (message) => {
      if (failureError) return;
      try {
        if (message.event === "configure")
          send({ admin, secret, rotatedSecret, artifactParent: pinDirectory });
        if (message.event === "restart-pin") {
          if (!pins) throw Error("STARTUP_PINS_REQUIRED");
          const next = {
            ...pins,
            bridge: loopbackOrigin(message.origin),
            version: pins.version + 1,
          };
          publishPins(pinPath, next);
          pins = next;
          send({
            event: "restart-pinned",
            origin: pins.bridge,
            version: pins.version,
          });
        }
        if (message.event === "ready") {
          if (pins) throw Error("DUPLICATE_STARTUP_PINS");
          const next = {
            version: 1,
            bridge: loopbackOrigin(message.origin),
            control: loopbackOrigin(message.control),
          };
          publishPins(pinPath, next);
          pins = next;
          clearTimeout(startupTimer);
          resolveReady({ origin: pins.bridge, control: pins.control });
        }
      } catch (error) {
        fail(error);
      }
    };
    const onListenerExit = () => fail(Error("Worker bridge supervisor exited"));
    let disposed = false;
    disposeSupervision = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(startupTimer);
      listener.removeListener("message", onMessage);
      listener.removeListener("error", fail);
      listener.removeListener("exit", onListenerExit);
      if (onTestError) tests?.removeListener("error", onTestError);
      if (onTestExit) tests?.removeListener("exit", onTestExit);
    };
    listener.on("message", onMessage);
    listener.on("error", fail);
    listener.on("exit", onListenerExit);
    startupTimer = setTimeout(
      () => fail(Error("Worker bridge supervisor startup deadline")),
      15000,
    );
    const ready = await untilFailure(readyPromise);
    if (failureError) throw failureError;
    tests = spawnProcess(
      "pnpm",
      ["--filter", "@lyraseo/worker", "test", ...testArgs],
      {
        cwd: root,
        detached: true,
        stdio: "inherit",
        env: {
          ...env,
          LYRA_WORKER_BRIDGE: ready.origin,
          LYRA_WORKER_CONTROL: ready.control,
          LYRA_WORKER_SECRET: secret,
          LYRA_WORKER_ROTATED_SECRET: rotatedSecret,
          LYRA_WORKER_PINS_PATH: pinPath,
        },
      },
    );
    const status = await untilFailure(
      new Promise((resolve, reject) => {
        onTestError = reject;
        onTestExit = resolve;
        tests.once("error", onTestError);
        tests.once("exit", onTestExit);
      }),
    );
    if (failureError) throw failureError;
    if (status !== 0)
      throw Object.assign(Error("Workers runtime suite failed"), {
        exitCode: status ?? 1,
      });
    passed = true;
  } finally {
    await cleanup();
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runWorkerBridge({ testArgs: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
