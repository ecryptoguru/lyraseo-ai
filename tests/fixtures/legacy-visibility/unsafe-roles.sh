set -eu
migration_guard=$1
bootstrap_guard=$2
scratch=$(mktemp -d /tmp/lyraseo-legacy-unsafe.XXXXXXXX)
active=
cleanup() {
 if [ -n "$active" ]; then pg_ctl -D "$active" -m immediate -w stop >/dev/null || true; fi
 rm -rf "$scratch"
}
trap cleanup EXIT
initdb -D "$scratch/cluster" -A trust >/dev/null
active="$scratch/cluster"
pg_ctl -D "$active" -l "$scratch/postmaster.log" -o "-p 55464 -k $scratch -c listen_addresses=''" -w start >/dev/null
q() { psql -X -h "$scratch" -p 55464 -U postgres -d postgres -At -v ON_ERROR_STOP=1 "$@"; }
q -c 'CREATE ROLE lyraseo_legacy_visibility_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION; CREATE ROLE legacy_other NOLOGIN;' >/dev/null
q -f "$migration_guard" >/dev/null
[ "$(q -f "$bootstrap_guard")" = f ]
check() {
 label=$1
 [ "$(q -f "$bootstrap_guard")" = t ] || { echo "FAIL bootstrap accepted $label"; exit 1; }
 if q -f "$migration_guard" >"$scratch/result" 2>&1; then echo "FAIL migration accepted $label"; exit 1; fi
 if ! grep -q UNSAFE_LEGACY_VISIBILITY_OWNER "$scratch/result"; then cat "$scratch/result"; echo "FAIL unexpected failure $label"; exit 1; fi
 echo "PASS unsafe legacy role rejected: $label"
}
for setting in LOGIN INHERIT SUPERUSER BYPASSRLS CREATEDB CREATEROLE REPLICATION; do
 q -c "ALTER ROLE lyraseo_legacy_visibility_owner $setting" >/dev/null
 check "$setting"
 q -c "ALTER ROLE lyraseo_legacy_visibility_owner NO$setting" >/dev/null
done
q -c 'GRANT legacy_other TO lyraseo_legacy_visibility_owner' >/dev/null
check 'owner membership'
q -c 'REVOKE legacy_other FROM lyraseo_legacy_visibility_owner' >/dev/null
q -c 'GRANT lyraseo_legacy_visibility_owner TO legacy_other' >/dev/null
check 'owner granted to another role'
q -c 'REVOKE lyraseo_legacy_visibility_owner FROM legacy_other' >/dev/null
q -c 'CREATE DATABASE legacy_unsafe_owner OWNER lyraseo_legacy_visibility_owner' >/dev/null
check 'database ownership'
q -c 'DROP DATABASE legacy_unsafe_owner' >/dev/null
q -c 'CREATE TABLE legacy_unsafe_table(id int); ALTER TABLE legacy_unsafe_table OWNER TO lyraseo_legacy_visibility_owner' >/dev/null
check 'table ownership'
q -c 'DROP TABLE legacy_unsafe_table' >/dev/null
q -c 'CREATE SCHEMA legacy_unsafe_schema AUTHORIZATION lyraseo_legacy_visibility_owner' >/dev/null
check 'schema ownership'
q -c 'DROP SCHEMA legacy_unsafe_schema' >/dev/null
q -c 'CREATE FUNCTION legacy_unsafe_function() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$; ALTER FUNCTION legacy_unsafe_function() OWNER TO lyraseo_legacy_visibility_owner' >/dev/null
check 'unexpected function ownership'
q -c 'DROP FUNCTION legacy_unsafe_function()' >/dev/null
q -c 'CREATE TABLE legacy_unexpected_grant(id int); GRANT SELECT ON legacy_unexpected_grant TO lyraseo_legacy_visibility_owner' >/dev/null
check 'unexpected table grant'
q -c 'DROP TABLE legacy_unexpected_grant' >/dev/null
[ "$(q -f "$bootstrap_guard")" = f ]
echo 'PASS unsafe role checks on isolated postmaster'
