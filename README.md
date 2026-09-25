# Background Jobs System

A production-shaped job queue. Slow or unreliable work is moved off the request
path, executed by a separate worker process, retried with exponential backoff and
jitter, and fully accounted for — including when it dies and needs a human.

```
POST /api/v1/jobs   →  202 Accepted, one row written, returns immediately
                        │
                        ▼
              ┌──────────────────────┐
              │  worker process      │  claim → execute → mark
              │  (separate process)  │  FOR UPDATE SKIP LOCKED
              └──────────────────────┘
                        │
       pending ────────►┴────────► succeeded
          ▲                          (terminal)
          │ retry + backoff
          └──────── failed
                       │ attempts exhausted
                       ▼
                     dead ──► manual retry from the dead letter view
                     (terminal)
```

`processing` is the transient middle state. A job found there for longer than
`JOB_STUCK_TIMEOUT_SECONDS` belonged to a worker that died, and is swept back to
`pending`.

## Quick start

Requires Node 20+ and a PostgreSQL database.

```bash
npm install
cp .env.example .env          # then set DATABASE_URL
npm run migrate               # creates tables, indexes, constraints, trigger
npm run server                # terminal 1: the API on :3000
npm run worker                # terminal 2: the worker
```

Open <http://localhost:3000> for the enqueue form, the status view, and the dead
letter queue.

```bash
npm test                      # 8 tests: the five break-it scenarios plus 3 more
npm run evidence              # regenerates everything in evidence/
```

## Configuration

Every number lives in `.env`. Nothing is hardcoded in a handler.

| Variable | Default | Meaning |
|---|---|---|
| `JOB_CONCURRENCY_CAP` | `10` | Max jobs this worker runs at once. Bounds your outbound call rate. |
| `JOB_MAX_ATTEMPTS` | `5` | Attempts before a job dies. Stamped onto the row at enqueue time. |
| `JOB_CLAIM_INTERVAL_SECONDS` | `2` | Idle poll interval when the queue is empty. |
| `JOB_BACKOFF_BASE_SECONDS` | `5` | First retry delay. Delay is `base × 2^(attempt-1)`. |
| `JOB_BACKOFF_JITTER_PERCENT` | `10` | Jitter as a percentage of the calculated delay. |
| `JOB_STUCK_TIMEOUT_SECONDS` | `3600` | A job in `processing` longer than this is presumed abandoned. |
| `JOB_CLEANUP_INTERVAL_SECONDS` | `300` | How often the stuck sweep runs. |
| `JOB_HEARTBEAT_INTERVAL_SECONDS` | `10` | How often the in-flight gauge is logged. |
| `DATABASE_URL` | — | Required. `postgresql://user:pass@host:port/db`. |
| `PORT` | `3000` | API port. |
| `DATA_DIR` | `./data/external` | Where simulated providers persist state. |

`loadConfig` validates all of them on startup and refuses to boot on a bad value
rather than failing later at 3am.

## API

All paths are versioned under `/api/v1`.

### `POST /api/v1/jobs` — enqueue

Writes one row and returns. It never performs the work.

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send_email",
    "payload": { "to": "user@example.com", "subject": "Welcome" },
    "idempotency_key": "user_alice_welcome"
  }'
```

```json
202 Accepted
{ "job_id": "job_61a5addae27f49c0ba34847609e20958", "status": "pending", "created_at": "2026-09-25T19:27:20.870Z" }
```

| Status | Code | When |
|---|---|---|
| `202` | — | Accepted, including when the idempotency key already existed (returns the existing job) |
| `400` | `INVALID_REQUEST` | Missing `type`, `payload`, or `idempotency_key` |
| `409` | `DUPLICATE_IDEMPOTENCY_KEY` | Same key, different payload |
| `500` | `DATABASE_ERROR` | Write failed |

### `GET /api/v1/jobs/:id` — status

```bash
curl http://localhost:3000/api/v1/jobs/job_61a5addae27f49c0ba34847609e20958
```

```json
{
  "job_id": "job_61a5...",
  "type": "send_email",
  "status": "processing",
  "attempts": 2,
  "max_attempts": 5,
  "last_error": null,
  "run_at": "2026-09-25T19:27:20.870Z",
  "started_at": "2026-09-25T19:27:21.104Z",
  "finished_at": null,
  "created_at": "2026-09-25T19:27:20.870Z",
  "updated_at": "2026-09-25T19:27:21.104Z"
}
```

`404 NOT_FOUND` if the id is unknown. A malformed id is a 404, never a 500.

### `GET /api/v1/jobs/dead` — dead letter queue

```bash
curl "http://localhost:3000/api/v1/jobs/dead?limit=20&offset=0"
```

```json
{
  "jobs": [{
    "id": "job_8b0ae2ff...",
    "type": "always_fails",
    "payload": { "message": "Evidence: dependency is down" },
    "idempotency_key": "evidence_dead",
    "attempts": 1, "max_attempts": 1,
    "last_error": "Evidence: dependency is down",
    "created_at": "...", "started_at": "...", "run_at": "...", "finished_at": "...",
    "seconds_to_die": 1
  }],
  "meta": { "total": 1, "limit": 20, "offset": 0, "has_more": false }
}
```

`limit` defaults to 20 and is clamped to 100. A negative or non-numeric `limit`
or `offset` is a `400`. Asking for page 50 of a 1-page collection returns `200`
with an empty `jobs` array and `has_more: false` — graceful degradation, not an
error.

### `POST /api/v1/jobs/:id/retry` — manual retry

Only works on a `dead` job. Grants two more attempts and requeues immediately.

```bash
curl -X POST http://localhost:3000/api/v1/jobs/job_8b0ae2ff.../retry
```

```json
202 Accepted
{ "job_id": "job_8b0ae2ff...", "status": "pending", "attempts": 1, "max_attempts": 3 }
```

`404` if the job does not exist or is not dead.

### `GET /` — the view

One page: enqueue a job, poll a job's status, and work the dead letter queue with
a Retry button per row. Rendered client-side with DOM APIs and `textContent`, so
nothing from a job payload is ever interpolated into markup.

## Job types

| Type | Idempotency strategy |
|---|---|
| `send_email` | **A** — passes `job.id` to the provider as an idempotency key |
| `generate_pdf` | **B** — stores output under `pdf_<job id>`, returns the stored copy if present |
| `charge_card` | **C** — dedupes on a `charges` row keyed by `job id` |
| `quick_work` | test fixture, returns immediately |
| `slow_work` | test fixture, sleeps `payload.delayMs` |
| `always_fails` | test fixture, always throws |
| `hang_forever` | test fixture, never resolves — used to strand a job in `processing` |

## Design decisions

**The database resolves races, not the application.** A claim is one statement:
`UPDATE jobs SET status='processing' WHERE id = (SELECT id ... FOR UPDATE SKIP
LOCKED) RETURNING *`. Two workers running the same statement against the same
candidate row means one blocks and the other skips to the next row. There is no
read-then-write window to lose, because there is no read step.

**`failed` and `dead` are different states and the schema treats them that way.**
`failed` means "this attempt threw, a retry is scheduled" — non-terminal, no
`finished_at`. `dead` means "retries exhausted" — terminal, `finished_at` set.
Conflating them is the most common way a job queue ends up either retrying forever
or silently dropping work.

**The spec I worked from contradicted itself, and I had to pick a side.** The
`finished_has_timestamps` constraint as written required `finished_at` on
`failed`, while the failure path in the same document sets it to `NULL` and the
field table describes it as "when job succeeded or went dead". Those cannot all
be true. I took the field table and §3's "failed is not a terminal state" as
authoritative, so only `succeeded` and `dead` are terminal, and the constraint
enforces that in both directions. The first version of this code shipped the
contradiction as-is and the very first job failure threw a `23514` instead of
recording the failure.

**A `CHECK` constraint cannot enforce a transition.** It validates one row in
isolation; it cannot see the row being replaced. So a job could go from
`succeeded` back to `processing` and every column-level constraint would be
satisfied. That needs a trigger, and there is one
(`trg_jobs_status_transition`) with an explicit transition table. Test 7 proves
the re-claim is rejected.

**Work must be idempotent because at-least-once is the only thing available.**
A worker can finish the work and die before writing `succeeded`. There is no
atomic way to commit an external side effect and a database row together, so the
honest position is that the work will sometimes run twice, and each handler is
responsible for making that safe — provider key, output key, or dedupe row. All
three are keyed on `job.id`, which is stable across every retry.

**If marking a job succeeded fails, that is not a work failure.** The work
already happened. The worker logs it and leaves the row in `processing`, so the
stuck sweep requeues it and the idempotent handler runs again. Recording it as a
failure instead would put a misleading message in `last_error` and burn an attempt
for something that was not the work's fault.

**A worker that cannot reach the database should die.** After 5 consecutive loop
errors it logs and exits, on the assumption a supervisor will restart it. The
alternative — looping forever on the same error — hides the outage and keeps a
process pinned to a dead connection.

## Testing

```bash
npm test
```

| Test | Proves |
|---|---|
| 1 | 50 jobs, cap 5, observed max concurrency never exceeds 5 |
| 2 | retries with 5s then 10s backoff, then dies at `max_attempts` |
| 3 | a job stranded in `processing` is swept back to `pending` and re-executed |
| 4 | one idempotency key produces exactly one job; 409 on a different payload |
| 5 | two workers, 20 jobs, zero overlap in claims |
| 6 | running each handler twice still produces one output |
| 7 | the database rejects five invalid states, and still allows the legal path |
| 8 | dead letter paging degrades gracefully past the end |

Test 2 captures its timeline from worker hooks rather than by polling. Polling
cannot reliably observe `processing` for a handler that throws in under a
millisecond — the state exists for a few milliseconds and a 200ms poll misses it.
That was a real flake in an earlier version of this suite.

Every worker and server created by a test is registered and torn down in
`beforeEach`. A worker that outlives its test keeps claiming rows across the next
test's `TRUNCATE`, which silently corrupts that test's assertions and keeps the
process alive after the run.

## Evidence

`npm run evidence` drives the real `src/server.js` and `src/worker/main.js` as
child processes and writes `evidence/console-output.txt`. See
[`evidence/README.md`](evidence/README.md) for what each artefact shows and which
brief requirement it satisfies.

## Defence

**Two workers are running. Walk me through how they never process the same job.**
Both run the identical single statement. The `SELECT ... LIMIT 1 FOR UPDATE SKIP
LOCKED` inside the `UPDATE` picks a candidate and locks it. If worker B's
statement targets a row worker A already locked, `SKIP LOCKED` makes B skip that
row entirely rather than block, so B takes the next candidate or nothing. Only one
`UPDATE` can flip a given row from `pending` to `processing`, and
`RETURNING *` hands the row to exactly one caller. There is no read-then-write
window because there is no separate read.

**The worker crashed after sending the email but before marking the job done.**
The row is left in `processing`. Every `JOB_CLEANUP_INTERVAL_SECONDS` the sweep
finds rows in `processing` whose `started_at` is older than
`JOB_STUCK_TIMEOUT_SECONDS`, and resets them to `pending` with `attempts + 1`. The
job is then reclaimed. The email is not sent twice because `send_email` passes
`job.id` to the provider as an idempotency key, so the retry returns the original
message instead of sending a new one. This is safe for `charge_card` too, because
the `charges` row keyed on `job.id` is checked before the card is charged.

**Why jitter? Show me the line.**
`src/worker/worker.js`, in `calculateBackoff`:

```js
const exponential = backoffBaseSeconds * Math.pow(2, attempt - 1);
const jitterRange = exponential * (backoffJitterPercent / 100);
const jitter = Math.random() * jitterRange - jitterRange / 2;   // ← this line
return exponential + jitter;
```

Without it, every job that failed at the same instant retries at the same
instant. A hundred jobs hit a failing dependency at 10:00:00, all retry at
10:00:05, and hammer it again together. The jitter spreads them across a window
proportional to the delay, so the load is spread as the delay grows.

**A job has been in `processing` for an hour. What does the system do, and when?**
Every `JOB_CLEANUP_INTERVAL_SECONDS` (default 300s), the sweep updates every job
in `processing` whose `started_at` is older than `JOB_STUCK_TIMEOUT_SECONDS`
(default 3600s) back to `pending`, increments `attempts`, and sets `run_at` to
`NOW()`. The next claim cycle picks it up. Note the sweep runs inside the worker
rather than as a separate cron process, so there is nothing extra to deploy — but
it does mean recovery only happens if at least one worker is alive.
