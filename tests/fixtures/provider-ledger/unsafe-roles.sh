#!/bin/sh
set -eu
migration=$1
root=$(mktemp -d /tmp/lyraseo-ledger-role-check.XXXXXX)
cleanup(){ pg_ctl -D "$root/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$root"; }
trap cleanup EXIT INT TERM
initdb -D "$root/data" -A trust --no-locale >/dev/null
pg_ctl -D "$root/data" -o "-k $root -p 55479 -c listen_addresses=''" -w start >/dev/null
psql_fixture(){ psql -X -h "$root" -p 55479 -d postgres -v ON_ERROR_STOP=1 "$@"; }
psql_fixture -c 'CREATE ROLE lyraseo_ledger_owner NOLOGIN NOINHERIT; CREATE ROLE lyraseo_ledger_fixture LOGIN NOINHERIT;' >/dev/null
check_rejected(){
 label=$1
 if psql_fixture -f "$migration" >"$root/result" 2>&1; then echo "UNSAFE_LEDGER_ACCEPTED:$label"; exit 1; fi
 if ! grep -q 'UNSAFE_LEDGER_ROLE' "$root/result"; then cat "$root/result"; echo "WRONG_LEDGER_FAILURE:$label"; exit 1; fi
 echo "PASS: unsafe ledger role rejected: $label"
}
for attribute in LOGIN INHERIT SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS; do
 psql_fixture -c "ALTER ROLE lyraseo_ledger_owner $attribute" >/dev/null
 check_rejected "owner-$attribute"
 psql_fixture -c 'ALTER ROLE lyraseo_ledger_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS' >/dev/null
done
psql_fixture -c 'ALTER ROLE lyraseo_ledger_fixture NOLOGIN' >/dev/null
check_rejected fixture-nologin
psql_fixture -c 'ALTER ROLE lyraseo_ledger_fixture LOGIN; GRANT lyraseo_ledger_owner TO lyraseo_ledger_fixture' >/dev/null
check_rejected membership
psql_fixture -c 'REVOKE lyraseo_ledger_owner FROM lyraseo_ledger_fixture; CREATE TABLE owned_probe(id int); ALTER TABLE owned_probe OWNER TO lyraseo_ledger_owner' >/dev/null
check_rejected table-owner
psql_fixture -c 'DROP TABLE owned_probe; CREATE SCHEMA owned_probe AUTHORIZATION lyraseo_ledger_owner' >/dev/null
check_rejected schema-owner
psql_fixture -c 'DROP SCHEMA owned_probe; ALTER DATABASE postgres OWNER TO lyraseo_ledger_owner' >/dev/null
check_rejected database-owner
