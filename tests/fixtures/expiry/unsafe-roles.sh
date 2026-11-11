set -eu
migration_file=$1
bootstrap_guard=$2
scratch=$(mktemp -d /tmp/lyraseo-expiry-unsafe.XXXXXXXX)
active=
cleanup() {
 if [ -n "$active" ]; then pg_ctl -D "$active" -m immediate -w stop >/dev/null || true; fi
 rm -rf "$scratch"
}
trap cleanup EXIT
initdb -D "$scratch/cluster" -A trust >/dev/null
active="$scratch/cluster"
pg_ctl -D "$active" -l "$scratch/postmaster.log" -o "-p 55463 -k $scratch -c listen_addresses=''" -w start >/dev/null
q() { psql -X -h "$scratch" -p 55463 -U postgres -d postgres -At -v ON_ERROR_STOP=1 "$@"; }
q -c "CREATE ROLE lyraseo_artifact_maintenance LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE ROLE lyraseo_expiry_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE ROLE expiry_other NOLOGIN;" >/dev/null
[ "$(q -f "$bootstrap_guard")" = f ]
check() {
 label=$1
 [ "$(q -f "$bootstrap_guard")" = t ] || { echo "FAIL bootstrap predicate $label"; exit 1; }
 if q -f "$migration_file" >"$scratch/result" 2>&1; then echo "FAIL migration accepted $label"; exit 1; fi
 if ! grep -q UNSAFE_EXPIRY_ROLE "$scratch/result"; then cat "$scratch/result"; echo "FAIL unexpected migration failure $label"; exit 1; fi
 echo "PASS bootstrap predicate and migration reject $label"
}
for setting in SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION INHERIT; do
 q -c "ALTER ROLE lyraseo_artifact_maintenance $setting" >/dev/null
 check "$setting"
 q -c "ALTER ROLE lyraseo_artifact_maintenance NO$setting" >/dev/null
done
q -c 'ALTER ROLE lyraseo_expiry_owner LOGIN' >/dev/null
check 'owner LOGIN'
q -c 'ALTER ROLE lyraseo_expiry_owner NOLOGIN' >/dev/null
q -c 'GRANT expiry_other TO lyraseo_artifact_maintenance' >/dev/null
check 'maintenance membership'
q -c 'REVOKE expiry_other FROM lyraseo_artifact_maintenance' >/dev/null
q -c 'GRANT lyraseo_expiry_owner TO expiry_other' >/dev/null
check 'owner granted to another role'
q -c 'REVOKE lyraseo_expiry_owner FROM expiry_other' >/dev/null
q -c 'CREATE DATABASE unsafe_owned OWNER lyraseo_expiry_owner' >/dev/null
check 'expiry role owns database'
q -c 'DROP DATABASE unsafe_owned' >/dev/null
[ "$(q -f "$bootstrap_guard")" = f ]
echo 'PASS safe definitions restored in isolated cluster'
