import { expect, it } from "vitest";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function invoke(config: unknown, args: string[] = [], enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "lyraseo-privacy-cli-")),
    path = join(root, "config");
  writeFileSync(
    path,
    typeof config === "string" ? config : JSON.stringify(config),
    { mode: 0o600 },
  );
  const fd = openSync(path, "r");
  try {
    return spawnSync(
      process.execPath,
      ["scripts/privacy-retention.mjs", "history-preview", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LYRA_LOCAL_PRIVACY_ENABLED: String(enabled),
          LYRA_LOCAL_PRIVACY_CONFIG_FD: "3",
        },
        stdio: ["ignore", "pipe", "pipe", fd],
        encoding: "utf8",
      },
    );
  } finally {
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}
const secret = "PRIVACY_CONFIG_SECRET_NEVER_PRINT";
it("refuses malformed secret-bearing configuration without reflecting its contents", () => {
  const result = invoke({
    databaseUrl: `postgresql://user:${secret}@bad host`,
    scope: { workspaceId: "a", siteId: "a-site" },
  });
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).not.toContain(secret);
  expect(result.stderr).toContain("UNSAFE_LOCAL_PRIVACY_CONFIGURATION");
});
it("refuses canonical databases, arbitrary options and disabled execution before any SQL", () => {
  const config = {
    databaseUrl: `postgresql://lyraseo_artifact_maintenance:${secret}@127.0.0.1:54329/lyraseo_test`,
    scope: { workspaceId: "a", siteId: "a-site" },
  };
  const canonical = invoke(config);
  expect(canonical.status).not.toBe(0);
  expect(canonical.stderr).toContain("UNSAFE_LOCAL_PRIVACY_CONFIGURATION");
  const option = invoke(config, ["--as-of", "2099-01-01"]);
  expect(option.stderr).toContain("INVALID_LOCAL_PRIVACY_OPTION");
  const disabled = invoke(config, [], false);
  expect(disabled.stderr).toContain("LOCAL_PRIVACY_DISABLED");
  expect(
    canonical.stdout + canonical.stderr + option.stderr + disabled.stderr,
  ).not.toContain(secret);
});
