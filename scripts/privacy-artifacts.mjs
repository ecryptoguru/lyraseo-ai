#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { register } from "node:module";

register(new URL("./privacy-ts-loader.mjs", import.meta.url), import.meta.url);
const { createDatabase } = await import("../packages/db/src/index.ts");
const { localAuditArtifactStore } =
  await import("../packages/db/src/artifact-store.ts");
const {
  applyPrivateArtifactExpiry,
  bindLocalExpiryAuthority,
  pausePrivateArtifactExpiry,
  previewPrivateArtifactExpiry,
  privateArtifactExpiryStatus,
  recordPrivateArtifactExpiryPlan,
  unbindLocalExpiryAuthority,
} = await import("../packages/db/src/artifact-expiry.ts");

if (process.env.LYRA_PRIVATE_EXPIRY_ENABLED !== "true")
  throw Error("PRIVATE_EXPIRY_DISABLED");
const command = process.argv[2];
if (
  ![
    "artifact-plan",
    "artifact-record-plan",
    "artifact-apply",
    "artifact-reconcile",
    "artifact-status",
    "artifact-pause",
  ].includes(command)
)
  throw Error("INVALID_PRIVATE_EXPIRY_COMMAND");
const allowed = {
  "artifact-plan": ["limit", "cursor"],
  "artifact-record-plan": ["manifest-fd", "hash"],
  "artifact-apply": ["plan-id", "hash", "limit"],
  "artifact-reconcile": ["plan-id", "hash", "limit"],
  "artifact-status": ["plan-id"],
  "artifact-pause": ["plan-id"],
}[command];
const seen = new Set();
for (let index = 3; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  if (
    !flag?.startsWith("--") ||
    !allowed.includes(flag.slice(2)) ||
    seen.has(flag) ||
    !process.argv[index + 1] ||
    process.argv[index + 1].startsWith("--")
  )
    throw Error("INVALID_PRIVATE_EXPIRY_OPTION");
  seen.add(flag);
}
function fdFromEnv(name) {
  const value = process.env[name];
  if (!/^[3-9][0-9]*$/.test(value ?? ""))
    throw Error("PRIVATE_CONFIG_FD_REQUIRED");
  return Number(value);
}
function option(name, required = false) {
  const index = process.argv.indexOf("--" + name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (required && (!value || value.startsWith("--")))
    throw Error("INVALID_PRIVATE_EXPIRY_OPTION");
  return value;
}
const config = JSON.parse(
  readFileSync(fdFromEnv("LYRA_PRIVATE_EXPIRY_CONFIG_FD"), "utf8"),
);
const url = new URL(config.databaseUrl);
if (
  url.protocol !== "postgresql:" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "54329" ||
  url.username !== "lyraseo_artifact_maintenance" ||
  !/^\/lyraseo_expiry_[a-f0-9]{8,12}$/.test(url.pathname) ||
  !url.password ||
  url.search ||
  !isAbsolute(config.root) ||
  !/^[a-f0-9]{64}$/.test(config.secretHex) ||
  !config.origin
)
  throw Error("PRIVATE_CONFIG_INVALID");
const scope = { workspaceId: config.workspaceId, siteId: config.siteId };
const limit = Number(option("limit") ?? "100");
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw Error("INVALID_LIMIT");
const db = createDatabase(config.databaseUrl);
const store = await localAuditArtifactStore(config.root);
try {
  bindLocalExpiryAuthority(store, {
    keyId: config.keyId,
    secret: Buffer.from(config.secretHex, "hex"),
    scope,
    origin: config.origin,
  });
  let result;
  if (command === "artifact-plan") {
    result = await previewPrivateArtifactExpiry(
      db,
      store,
      scope,
      limit,
      option("cursor") ?? null,
    );
  } else if (command === "artifact-record-plan") {
    const manifestFd = Number(option("manifest-fd", true));
    if (!Number.isInteger(manifestFd) || manifestFd < 3)
      throw Error("INVALID_PRIVATE_EXPIRY_OPTION");
    const manifest = JSON.parse(readFileSync(manifestFd, "utf8"));
    result = await recordPrivateArtifactExpiryPlan(
      db,
      store,
      scope,
      manifest,
      option("hash", true),
    );
  } else if (command === "artifact-apply" || command === "artifact-reconcile") {
    result = await applyPrivateArtifactExpiry(
      db,
      store,
      scope,
      option("plan-id", true),
      option("hash", true),
      limit,
      command === "artifact-reconcile",
    );
  } else if (command === "artifact-status") {
    result = await privateArtifactExpiryStatus(
      db,
      scope,
      option("plan-id", true),
    );
  } else {
    result = await pausePrivateArtifactExpiry(
      db,
      store,
      scope,
      option("plan-id", true),
    );
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  unbindLocalExpiryAuthority(store);
  await Promise.all([store.close(), db.$disconnect()]);
}
