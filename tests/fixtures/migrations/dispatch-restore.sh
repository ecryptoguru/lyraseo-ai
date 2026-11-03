# Executed as the postgres OS user inside the validated disposable container.
# Two postmasters, private Unix sockets, no external listener. Copy only the
# freshly initialized synthetic cluster, never the canonical PGDATA directory.
set -eu
source_db=$1
scratch=$(mktemp -d /tmp/lyraseo-dispatch-restore.XXXXXXXX)
active=
cleanup() {
  if [ -n "$active" ]; then pg_ctl -D "$active" -m immediate -w stop >/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
port=55462
boot() {
  active=$1
  pg_ctl -D "$active" -l "$scratch/postmaster.log" -o "-p $port -k $scratch -c listen_addresses=''" -w start >/dev/null
}
query() {
  psql -h "$scratch" -p "$port" -d postgres -U "$1" -qAt -v ON_ERROR_STOP=1 -c "$2"
}
initdb -D "$scratch/source" -A trust >/dev/null
boot "$scratch/source"
query postgres 'CREATE ROLE lyraseo_kernel_owner NOLOGIN; CREATE ROLE lyraseo_dispatch LOGIN; CREATE ROLE lyraseo_operator LOGIN;
CREATE ROLE lyraseo_runtime LOGIN; CREATE ROLE lyraseo_identity LOGIN; CREATE ROLE anon LOGIN; CREATE ROLE authenticated LOGIN;
CREATE ROLE lyraseo_artifact_maintenance LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE lyraseo_expiry_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;'
pg_dump -U postgres -d "$source_db" --schema-only -f "$scratch/schema.sql"
psql -h "$scratch" -p "$port" -d postgres -U postgres -q -v ON_ERROR_STOP=1 -f "$scratch/schema.sql" >/dev/null
register='INSERT INTO lyraseo_kernel.test_environment(database_oid) SELECT oid FROM pg_database WHERE datname=current_database();'
query postgres "$register"
query postgres "
INSERT INTO \"RuntimePolicy\"(key,enabled) VALUES ('global',true),('audits',true);
INSERT INTO \"ProductUser\"(id) VALUES ('fixture');
INSERT INTO \"Workspace\"(id,name) VALUES ('w','isolated');
INSERT INTO \"Membership\"(\"workspaceId\",\"userId\",role) VALUES ('w','fixture','OWNER');
INSERT INTO \"Site\"(id,\"workspaceId\",origin,\"verifiedAt\") VALUES ('s','w','https://example.com',now());
INSERT INTO \"AuditRun\"(id,\"workspaceId\",\"siteId\",\"userId\",\"securityVersion\",\"idempotencyKey\",\"inputHash\",manifest,profile,declarations,\"methodologyVersion\")
VALUES ('a','w','s','fixture',0,'k','h','[]','CONTROLLED_RAW_TEST_V1','{}','fixture');
INSERT INTO \"WorkDispatch\"(\"workspaceId\",\"siteId\",\"userId\",\"admittedSecurityVersion\",\"auditId\",\"targetKind\",capability,profile,eligibility,\"admittedAt\",\"expiresAt\",disposition,\"nextAttemptAt\")
SELECT 'w','s','fixture',0,id,'AUDIT_RAW','audits',profile,'CONTROLLED_TEST',\"createdAt\",\"createdAt\"+interval '1 hour','PENDING',now() FROM \"AuditRun\";"
command="SELECT lyraseo_kernel.command(gen_random_uuid(),'lyraseo-kernel-a','/api/internal/runtime/dispatch','{\"limit\":1}',statement_timestamp(),statement_timestamp()+interval '1 minute');"
case "$(query lyraseo_dispatch "$command")" in *claimToken*) ;; *) echo 'Source fixture was not claimable'; exit 1;; esac
query postgres 'UPDATE "WorkDispatch" SET "claimToken"=NULL,"leaseUntil"=NULL;'
identity="SELECT system_identifier||'/'||(SELECT oid FROM pg_database WHERE datname=current_database()) FROM pg_control_system();"
original=$(query postgres "$identity")
source_boot=$(query postgres 'SELECT pg_postmaster_start_time();')
pg_ctl -D "$active" -m fast -w stop >/dev/null
active=
cp -a "$scratch/source" "$scratch/restored"
boot "$scratch/restored"
[ "$(query postgres "$identity")" = "$original" ]
[ "$(query postgres 'SELECT pg_postmaster_start_time();')" != "$source_boot" ]
result=$(query lyraseo_dispatch "$command")
case "$result" in *PAUSED*) ;; *) echo "FAIL: copied physical cluster inherited approval under the same system ID and database OID"; exit 1;; esac
query postgres 'TRUNCATE lyraseo_kernel.test_environment;'
query postgres "$register"
case "$(query lyraseo_dispatch "$command")" in *claimToken*) ;; *) echo 'Explicit requalification failed'; exit 1;; esac
echo "PASS: physical copy with identical cluster system identifier and database OID paused until independent postmaster registration."
