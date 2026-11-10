export function testDatabaseTarget(
  env: Record<string, string | undefined> = process.env,
) {
  const ownedName = env.LYRA_TEST_DB_NAME;
  if (
    ownedName !== undefined &&
    (ownedName !== ownedName.trim() ||
      !/^(?:(?:lyraseo_p2a[12]|lyraseo_origin|lyraseo_agency|lyraseo_ledger|lyraseo_recovery|lyraseo_legacy|lyraseo_review)_[a-f0-9]{12}|lyraseo_expiry_[a-f0-9]{8,12})$/.test(
        ownedName,
      ))
  )
    throw Error("INVALID_LOCAL_TEST_DATABASE");
  const hostPort = env.LYRA_TEST_DB_HOST_PORT ?? "54329";
  if (
    String(Number(hostPort)) !== hostPort ||
    !Number.isInteger(Number(hostPort)) ||
    Number(hostPort) < 1024 ||
    Number(hostPort) > 65535
  )
    throw Error("INVALID_LOCAL_TEST_DATABASE_PORT");
  const adminPassword = env.LYRA_TEST_DB_ADMIN_PASSWORD ?? "lyraseo_local_only";
  if (
    adminPassword.length < 16 ||
    adminPassword.length > 128 ||
    /[^A-Za-z0-9_-]/.test(adminPassword)
  )
    throw Error("INVALID_LOCAL_TEST_DATABASE_PASSWORD");
  const databaseName = ownedName ?? "lyraseo_test";
  const base = `127.0.0.1:${hostPort}/${databaseName}`;
  return {
    owned: ownedName !== undefined,
    databaseName,
    hostPort,
    adminPassword,
    adminUrl: `postgresql://postgres:${adminPassword}@${base}`,
    runtimeUrl: `postgresql://lyraseo_runtime:local_runtime_only@${base}`,
    identityUrl: `postgresql://lyraseo_identity:local_identity_only@${base}`,
  };
}

// Never derive a restricted login by replacing a hardcoded admin password.
export function testDatabaseRoleUrl(
  role: string,
  env: Record<string, string | undefined> = process.env,
) {
  const passwords: Record<string, string> = {
    lyraseo_runtime: "local_runtime_only",
    lyraseo_identity: "local_identity_only",
    lyraseo_dispatch: "local_dispatch_only",
  };
  if (!Object.hasOwn(passwords, role)) throw Error("INVALID_LOCAL_TEST_ROLE");
  const target = testDatabaseTarget(env);
  return `postgresql://${role}:${passwords[role]}@127.0.0.1:${target.hostPort}/${target.databaseName}`;
}
