import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { preparePrivacyMigrationPlan } from "../../scripts/lib/privacy-bootstrap.mjs";

const root = resolve(import.meta.dirname, "../..");
function fixture() {
  const tmp = mkdtempSync(resolve(tmpdir(), "lyra-privacy-preflight-"));
  mkdirSync(resolve(tmp, "packages/db/prisma"), { recursive: true });
  mkdirSync(resolve(tmp, "tests/fixtures"), { recursive: true });
  cpSync(
    resolve(root, "packages/db/prisma/migrations"),
    resolve(tmp, "packages/db/prisma/migrations"),
    { recursive: true },
  );
  cpSync(
    resolve(root, "tests/fixtures/migrations"),
    resolve(tmp, "tests/fixtures/migrations"),
    { recursive: true },
  );
  mkdirSync(resolve(tmp, "scripts/lib"), { recursive: true });
  for (const name of [
    "test-history-retention.mjs",
    "legacy-inline-baseline.mjs",
  ])
    cpSync(resolve(root, "scripts", name), resolve(tmp, "scripts", name));
  for (const name of ["privacy-bootstrap.mjs", "local-grants.mjs"])
    cpSync(
      resolve(root, "scripts/lib", name),
      resolve(tmp, "scripts/lib", name),
    );
  return tmp;
}

it("rejects unknown or changed migration and seed bytes before the real history runner calls Docker", () => {
  for (const mutation of [
    "unknown",
    "changed",
    "missing",
    "invalid-utf8",
    "seed",
    "audit-guard-drift",
    "audit-guard-missing",
  ]) {
    const tmp = fixture();
    try {
      const migrations = resolve(tmp, "packages/db/prisma/migrations");
      const target = resolve(
        migrations,
        "202611030010_privacy_recovery/migration.sql",
      );
      if (mutation === "unknown") {
        const dir = resolve(migrations, "202611030017_unreviewed");
        mkdirSync(dir);
        writeFileSync(resolve(dir, "migration.sql"), "SELECT 1;\n");
      } else if (mutation === "seed") {
        const seed = resolve(
          tmp,
          "tests/fixtures/migrations/pre-history-recovery.sql",
        );
        writeFileSync(
          seed,
          readFileSync(seed, "utf8") + "\n-- unqualified seed drift\n",
        );
      } else if (mutation === "audit-guard-drift") {
        const guard = resolve(
          migrations,
          "202611030018_audit_admission_guard/migration.sql",
        );
        writeFileSync(guard, readFileSync(guard, "utf8") + "\n-- drift\n");
      } else if (mutation === "audit-guard-missing") {
        rmSync(resolve(migrations, "202611030018_audit_admission_guard"), {
          recursive: true,
        });
      } else if (mutation === "changed")
        writeFileSync(target, readFileSync(target, "utf8") + "\n-- drift\n");
      else if (mutation === "invalid-utf8")
        writeFileSync(
          target,
          Buffer.concat([readFileSync(target), Buffer.from([255])]),
        );
      else rmSync(target);
      const bin = resolve(tmp, "bin");
      mkdirSync(bin);
      const marker = resolve(tmp, "docker-called");
      writeFileSync(
        resolve(bin, "docker"),
        `#!/bin/sh\nprintf called > '${marker}'\nexit 97\n`,
        { mode: 0o755 },
      );
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
      delete env.LYRA_RECOVERY_TEAM_MIGRATION;
      const child = spawnSync(
        process.execPath,
        [resolve(tmp, "scripts/test-history-retention.mjs")],
        { encoding: "utf8", env },
      );
      expect(child.status).not.toBe(0);
      expect(child.stderr).toMatch(
        /PRIVACY_MIGRATION_SET_UNQUALIFIED|HISTORY_SEED_UNQUALIFIED|ENOENT|encoded data was not valid/,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

it("qualifies only the exact optional team SQL before any database work", () => {
  const tmp = fixture();
  try {
    const team = "202611030009_agency_team";
    const path = resolve(tmp, "packages/db/prisma/migrations", team);
    const bytes = readFileSync(resolve(path, "migration.sql"), "utf8");
    expect(() =>
      preparePrivacyMigrationPlan(tmp, {
        profile: "assembled",
        teamSql: bytes,
      }),
    ).toThrow("UNQUALIFIED_TEAM_MIGRATION");
    rmSync(path, { recursive: true });
    const plan = preparePrivacyMigrationPlan(tmp, {
      profile: "assembled",
      teamSql: bytes,
    });
    expect(
      plan.steps.find((step: { name: string }) => step.name === team).sql,
    ).toBe(bytes);
    expect(() =>
      preparePrivacyMigrationPlan(tmp, {
        profile: "assembled",
        teamSql: bytes + "\n-- drift\n",
      }),
    ).toThrow("PRIVACY_MIGRATION_SET_UNQUALIFIED");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("retains the verified SQL bytes when files are changed after preflight", () => {
  const tmp = fixture();
  try {
    const plan = preparePrivacyMigrationPlan(tmp, { profile: "historical" });
    const original = plan.steps[0].sql;
    const path = resolve(
      tmp,
      "packages/db/prisma/migrations",
      plan.steps[0].name,
      "migration.sql",
    );
    writeFileSync(path, original + "\n-- post-preflight drift\n");
    expect(plan.steps[0].sql).toBe(original);
    expect(Object.isFrozen(plan.steps)).toBe(true);
    expect(Object.isFrozen(plan.steps[0])).toBe(true);
    expect(() =>
      preparePrivacyMigrationPlan(tmp, { profile: "historical" }),
    ).toThrow();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

it("executes verified history and seed SQL when files change after Docker inspection", () => {
  const tmp = fixture();
  try {
    const directory = resolve(
      tmp,
      "packages/db/prisma/migrations/202610230001_tenancy",
    );
    const target = resolve(directory, "migration.sql");
    const original = readFileSync(target, "utf8");
    const seed = resolve(
      tmp,
      "tests/fixtures/migrations/pre-history-recovery.sql",
    );
    const originalSeed = readFileSync(seed, "utf8");
    const bin = resolve(tmp, "bin");
    mkdirSync(bin);
    const trace = resolve(tmp, "psql-inputs");
    writeFileSync(
      resolve(bin, "docker"),
      `#!/bin/sh
if [ "$1" = inspect ]; then
  printf '\n-- post-preflight drift\n' >> "$LYRA_PREFLIGHT_TEST_TARGET"
  printf '\n-- post-preflight seed drift\n' >> "$LYRA_PREFLIGHT_TEST_SEED"
  printf '%s\n' '[{"Config":{"Image":"postgres:17-alpine"},"HostConfig":{"PortBindings":{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"54329"}]}}}]'
elif [ "$1" = exec ]; then
  case " $* " in *' psql '*) cat >> "$LYRA_PREFLIGHT_TEST_TRACE";; esac
fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(resolve(bin, "pnpm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      LYRA_PREFLIGHT_TEST_TARGET: target,
      LYRA_PREFLIGHT_TEST_SEED: seed,
      LYRA_PREFLIGHT_TEST_TRACE: trace,
    };
    delete env.LYRA_RECOVERY_TEAM_MIGRATION;
    const child = spawnSync(
      process.execPath,
      [resolve(tmp, "scripts/test-history-retention.mjs")],
      { encoding: "utf8", env },
    );
    expect(child.status).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("-- post-preflight drift");
    expect(readFileSync(seed, "utf8")).toContain(
      "-- post-preflight seed drift",
    );
    const sent = readFileSync(trace, "utf8");
    expect(sent).toContain(original);
    expect(sent).toContain(originalSeed);
    expect(sent).not.toContain("-- post-preflight drift");
    expect(sent).not.toContain("-- post-preflight seed drift");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
