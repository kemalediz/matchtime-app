# Disk IO: the temp files are Supabase's exporter, not MatchTime (26 Nov 2026)

Trace closed. Do not chase this again unless Supabase Disk IO warnings return.

## What was seen
- The postgres database writes about 10.6 MB of temp files (3 files) every 2 minutes, plus about 6.5 MB every 9 minutes. That works out to about 195 MB per half hour and 1.16 TB on `pg_stat_database.temp_bytes` since February.
- `pg_stat_statements` attributes almost none of it to any query: 4.2 MB in a 30 minute window.
- The counter jumps at about second 28 to 30, which made app queries look guilty.

## Proven cause
- `pg_ls_tmpdir()` was polled every 30 ms and each file's PID was matched to `pg_stat_activity`. Every burst is written by user `supabase_admin`, application `postgres_exporter` (Supabase's monitoring).
- It runs two summary queries over `extensions.pg_stat_statements` every 2 minutes at about second 18. The 9-minute burst is the same exporter.
- Example: 09:58:18 UTC, files `pgsql_tmp824357.63537` to `.63539` (2.06, 4.17 and 2.2 MB).
- The database counter shows each burst about 10 s late. Postgres 17 waits `PGSTAT_IDLE_INTERVAL` before flushing stats for a backend that has gone idle.
- Repro: `EXPLAIN (ANALYZE, BUFFERS)` of the exporter's SELECT shows `temp written=510` blocks, which is 4.18 MB.
- The exporter's own statements are not tracked in `pg_stat_statements`, which is why the bytes never show up per query.

## Why it spills
- `pg_stat_statements()` loads its whole result into memory. On 26 Nov it held 4,937 entries (limit `pg_stat_statements.max` = 5000) with 2.23 MB of query text. `work_mem` is 2184 kB, so every full read goes to disk.
- 4,867 of those entries are our app user `postgres`. Most are Prisma `IN ($1..$n)` queries, where every different list length is kept as a separate entry. They fill the 5,000 slots.

## Decision (PA, for Kemal, 26 Nov)
- Leave it. It is about 5 MB a minute of short-lived files, small next to the WAL fixes (#633, #634).
- If the Disk IO warnings return: measure first, then run `select pg_stat_statements_reset();` once (a write, so get approval) and re-sample.
- The lasting levers are fewer IN-list variants in our Prisma queries, or asking Supabase about the exporter.
- We cannot set `log_temp_files`: the `postgres` role is not a superuser and there is no Management API token.
