#!/usr/bin/env node
import { readSync } from "node:fs";
import { register } from "node:module";
register(new URL("./privacy-ts-loader.mjs", import.meta.url), import.meta.url);
if (process.env.LYRA_LOCAL_PRIVACY_ENABLED !== "true")
  throw Error("LOCAL_PRIVACY_DISABLED");
const command = process.argv[2];
const supported = {
  "history-preview": ["limit"],
  "history-record": ["manifest-fd", "hash"],
  "history-apply": ["plan-id", "hash", "limit"],
  "history-pause": ["plan-id"],
  "case-status": ["case-id"],
  "case-sweep": ["case-id", "limit"],
};
if (!Object.hasOwn(supported, command ?? ""))
  throw Error("INVALID_LOCAL_PRIVACY_COMMAND");
const options = new Map();
for (let index = 3; index < process.argv.length; index += 2) {
  const flag = process.argv[index],
    value = process.argv[index + 1];
  if (
    !flag?.startsWith("--") ||
    !supported[command].includes(flag.slice(2)) ||
    options.has(flag.slice(2)) ||
    !value ||
    value.startsWith("--")
  )
    throw Error("INVALID_LOCAL_PRIVACY_OPTION");
  options.set(flag.slice(2), value);
}
function fd(value) {
  if (!/^[3-9][0-9]*$/.test(value ?? ""))
    throw Error("LOCAL_PRIVACY_CONFIG_FD_REQUIRED");
  return Number(value);
}
function bounded(fd, maximum) {
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.alloc(Math.min(8192, maximum + 1 - total));
    const count = readSync(fd, chunk);
    if (!count) break;
    total += count;
    if (total > maximum) throw Error("LOCAL_PRIVACY_INPUT_TOO_LARGE");
    chunks.push(chunk.subarray(0, count));
  }
  return Buffer.concat(chunks).toString("utf8");
}
let config, url;
try {
  config = JSON.parse(
    bounded(fd(process.env.LYRA_LOCAL_PRIVACY_CONFIG_FD), 16384),
  );
  if (
    !config ||
    typeof config !== "object" ||
    typeof config.databaseUrl !== "string"
  )
    throw Error();
  url = new URL(config.databaseUrl);
} catch {
  throw Error("UNSAFE_LOCAL_PRIVACY_CONFIGURATION");
}
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "54329" ||
  url.username !== "lyraseo_artifact_maintenance" ||
  !url.password ||
  !/^\/lyraseo_recovery_[a-f0-9]{12}$/.test(url.pathname) ||
  url.search ||
  url.hash ||
  !config.scope ||
  Object.keys(config.scope).sort().join() !== "siteId,workspaceId" ||
  ![config.scope.workspaceId, config.scope.siteId].every(
    (value) =>
      typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value),
  )
)
  throw Error("UNSAFE_LOCAL_PRIVACY_CONFIGURATION");
const { createDatabase } = await import("../packages/db/src/index.ts");
const { localHistoryRetention } =
  await import("../packages/db/src/history-retention.ts");
const { localSiteDeletionMaintenance } =
  await import("../packages/db/src/site-deletion.ts");
const db = createDatabase(url.href),
  history = localHistoryRetention(db, { enabled: true }),
  deletion = localSiteDeletionMaintenance(db, { enabled: true });
function required(key, pattern) {
  const value = options.get(key);
  if (!value || !pattern.test(value))
    throw Error("INVALID_LOCAL_PRIVACY_OPTION");
  return value;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
  hash = /^[a-f0-9]{64}$/;
function limit(maximum, fallback) {
  const raw = options.get("limit") ?? String(fallback);
  if (!/^[1-9][0-9]*$/.test(raw) || Number(raw) > maximum)
    throw Error("INVALID_LOCAL_PRIVACY_LIMIT");
  return Number(raw);
}
try {
  let result;
  if (command === "history-preview")
    result = await history.preview(config.scope, limit(100, 100));
  if (command === "history-record")
    result = await history.record(
      config.scope,
      JSON.parse(bounded(fd(options.get("manifest-fd")), 65536)),
      required("hash", hash),
    );
  if (command === "history-apply")
    result = await history.apply(
      config.scope,
      required("plan-id", uuid),
      required("hash", hash),
      limit(100, 25),
    );
  if (command === "history-pause")
    result = await history.pause(config.scope, required("plan-id", uuid));
  if (command === "case-status")
    result = await deletion.status(config.scope, required("case-id", uuid));
  if (command === "case-sweep")
    result = await deletion.sweep(
      config.scope,
      required("case-id", uuid),
      limit(12, 3),
    );
  process.stdout.write(
    JSON.stringify({
      qualification: "LOCAL_TEST_ONLY",
      policy: "LOCAL_PRIVACY_V1",
      command,
      result,
    }) + "\n",
  );
} finally {
  await db.$disconnect();
}
