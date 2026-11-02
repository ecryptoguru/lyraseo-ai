// Owns only a random disposable database in the validated local harness.
import { spawn, spawnSync, fork } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { loopbackOrigin, writeIssuedPins } from "./lib/worker-test-mapper.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const container = "lyraseo-phase1-postgres";
export async function runWorkerBridge({
  command = spawnSync,
  testArgs = [],
  forkProcess = fork,
  spawnProcess = spawn,
  publishPins = writeIssuedPins,
  makePinDirectory = mkdtempSync,
  terminateGroup = (pid, signal) => process.kill(-pid, signal),
} = {}) {
  function run(cmd, args, options = {}) {
    const result = command(cmd, args, {
      cwd: root,
      stdio: "inherit",
      ...options,
    });
    if (result.status !== 0)
      throw Error(`Worker harness command failed: ${cmd}`);
    return result;
  }
  const inspected = JSON.parse(
    run("docker", ["inspect", container], { encoding: "utf8", stdio: "pipe" })
      .stdout,
  )[0];
  if (
    inspected.Config.Image !== "postgres:17-alpine" ||
    inspected.HostConfig.PortBindings["5432/tcp"]?.length !== 1 ||
    inspected.HostConfig.PortBindings["5432/tcp"][0].HostIp !== "127.0.0.1" ||
    inspected.HostConfig.PortBindings["5432/tcp"][0].HostPort !== "54329"
  )
    throw Error("Unexpected disposable DB container");
  const database = "lyraseo_worker_" + randomUUID().replaceAll("-", "");
  const sql = (statement) =>
    run(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
      ],
      { input: statement, stdio: ["pipe", "inherit", "inherit"] },
    );
  let listener, tests;
  let disposeSupervision = () => {};
  let ownsDatabase = false,
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
        if (ownsDatabase) {
          sql(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
          ownsDatabase = false;
        }
      } finally {
        if (pinDirectory)
          rmSync(pinDirectory, { recursive: true, force: true });
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
    sql(`CREATE DATABASE ${database}`);
    ownsDatabase = true;
    mkdirSync(resolve(root, "tmp"), { recursive: true });
    pinDirectory = makePinDirectory(resolve(root, "tmp/worker-carrier-"));
    pinPath = resolve(pinDirectory, "issued-pins.json");
    const admin = `postgresql://postgres:lyraseo_local_only@127.0.0.1:54329/${database}`;
    run(
      "pnpm",
      ["--filter", "@lyraseo/db", "exec", "prisma", "migrate", "deploy"],
      { env: { ...process.env, DIRECT_URL: admin } },
    );
    run(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-q",
      ],
      {
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
          send({ admin, secret, rotatedSecret });
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
          ...process.env,
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
    if (status !== 0) throw Error("Workers runtime suite failed");
  } finally {
    await cleanup();
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await runWorkerBridge({ testArgs: process.argv.slice(2) });
