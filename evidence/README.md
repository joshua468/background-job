# Evidence

Regenerate everything here with:

```bash
npm run evidence     # writes console-output.txt, drives the real server + worker
npm test             # writes test_1..test_8_*.json
```

`console-output.txt` is produced by spawning `src/server.js` and
`src/worker/main.js` as real child processes, not by the in-process test harness.
What is captured is what actually ships.

## Required evidence from the brief, and where it is

| Brief requirement | Where |
|---|---|
| Jobs table showing jobs in every status | `console-output.txt` → **JOBS TABLE** block. All five present: `dead=1 failed=1 pending=1 processing=1 succeeded=1`. |
| Timestamps showing backoff delays growing | `console-output.txt` → **Phase 5**. `before attempt 2=5.31s`, `before attempt 3=10.57s`, plus the `run_at` column moving then stopping. |
| Log output showing the concurrency cap holding under 50 jobs | `test_1_concurrency.json` → `concurrency_heartbeat_log_lines` and `max_concurrent_observed`. Sample: `Concurrent jobs: 5 of 5`, never 6. |
| Stuck-job recovery: before kill, after kill, after recovery | `test_3_stuck_recovery.json` → `before_kill`, `after_kill`, `after_recovery`, `final`. |
| Dead letter view with at least one job in it | `console-output.txt` → **Dead letter queue** block (JSON) and **Dead letter view** block (`GET /` serves the page with a Retry button). Screenshot the page at `http://127.0.0.1:3311/` while the demo runs. |

## Files

| File | Produced by | What it shows |
|---|---|---|
| `console-output.txt` | `npm run evidence` | Full narrative run: enqueue responses, idempotency replay and conflict, the all-status table, DLQ JSON, view check, backoff timeline |
| `test_1_concurrency.json` | `npm test` | 50 jobs, cap 5, every in-flight sample and the heartbeat log lines |
| `test_2_backoff.json` | `npm test` | Per-attempt claims, per-failure rows, backoff gaps, DLQ response, manual retry response |
| `test_3_stuck_recovery.json` | `npm test` | The four snapshots: claimed, stranded, recovered, re-executed |
| `test_4_idempotency.json` | `npm test` | Two identical submissions returning one `job_id`, reordered payload matching, 409 on conflict, row count of 1 |
| `test_5_two_workers.json` | `npm test` | Which worker claimed which job, and the empty overlap set |
| `test_6_idempotent_work.json` | `npm test` | Both runs of all three handlers, showing one output each |
| `test_7_constraint_violations.json` | `npm test` | Seven rejected invalid states, each naming the guard that rejected it |
| `test_8_dead_letter_paging.json` | `npm test` | Paging past the end, limit clamping, negative and non-numeric limits |

## How the all-status table is produced

No rows are inserted by hand. The run walks the system through every state:

- **pending** — enqueued while no worker is running (the queue backing up)
- **processing** — `hang_forever`, claimed and never resolving
- **succeeded** — `quick_work`, completes
- **dead** — `always_fails` against `JOB_MAX_ATTEMPTS=1`, dies on the first failure
- **failed** — a *second* `always_fails` job, manually retried via
  `POST /:id/retry`, which fails again and lands in `failed` with a one-hour
  backoff so it is still there when the table is printed

The first `always_fails` job is deliberately left dead so the dead letter queue
has something in it.

## Screenshots still to take

These need a human with a screen; the text artefacts above are what they should
be compared against.

1. `curl` output against the live API showing a paginated dead letter response.
2. The dead letter view in a browser with at least one job and its Retry button.
3. The jobs table with every status, from any Postgres client.
