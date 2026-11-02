BEGIN;
SET LOCAL ROLE lyraseo_kernel_owner;
-- Explain the actual private function body (a volatile function call conceals
-- its nested query plan in EXPLAIN). No planner switches or fabricated stats.
SELECT 'PREPARE dispatch_recovery_plan(timestamptz,integer,boolean) AS ' ||
 replace(replace(replace(prosrc,'batch_limit','$2'),'approved','$3'),'cutoff','$1')
 FROM pg_proc WHERE oid='lyraseo_kernel.recovery_ids(timestamptz,integer,boolean)'::regprocedure
\gexec
EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE dispatch_recovery_plan(statement_timestamp(),20,true);
ROLLBACK;
