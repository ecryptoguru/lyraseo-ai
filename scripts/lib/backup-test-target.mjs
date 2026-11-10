// Test harness only: no cloud URL or arbitrary database adoption.
export function backupTestTarget(env) {
  const name = env.LYRA_BACKUP_TEST_CONTAINER;
  const port = env.LYRA_BACKUP_TEST_PORT;
  const password = env.LYRA_BACKUP_TEST_ADMIN_PASSWORD;
  if (name === undefined && port === undefined && password === undefined)
    return {
      container: "lyraseo-phase1-postgres",
      port: 54329,
      password: "lyraseo_local_only",
    };
  if (
    !/^lyraseo-disposable-[0-9]{8}-[a-f0-9]{8}$/.test(name ?? "") ||
    !/^[1-9][0-9]{3,4}$/.test(port ?? "") ||
    Number(port) > 65535 ||
    typeof password !== "string" ||
    password.length === 0
  )
    throw Error("UNSAFE_BACKUP_TEST_TARGET");
  return { container: name, port: Number(port), password };
}
