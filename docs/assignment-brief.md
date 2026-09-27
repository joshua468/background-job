# Task 2: Background Jobs System Specification

## Overview

A production job queue that moves slow or unreliable work off the request path, survives failure, and provides full audit trail for every job. This document is the complete specification—everything here must be implemented exactly.

## 1. Architecture Principles

**Core rule**: Enqueue in request handler. Execute in separate worker process.

- **Request handler** writes one job row and returns 202 immediately
- **Worker process** claims pending jobs, executes work, handles failure atomically
- **Database** enforces all constraints—race conditions resolved at SQL layer, not application layer
- **Failure** is expected and handled; dead letter queue catches exhausted retries

---

## 2. Job Record Schema

Every job is one immutable row with complete lifecycle visibility.

### PostgreSQL Schema

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  last_error TEXT,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  idempotency_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_jobs_status_run_at ON jobs(status, run_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_jobs_idempotency_key ON jobs(idempotency_key);
CREATE INDEX idx_jobs_type ON jobs(type);

-- Enforce valid status transitions
ALTER TABLE jobs ADD CONSTRAINT valid_status 
  CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'dead'));

-- Ensure finished jobs have timestamps
ALTER TABLE jobs ADD CONSTRAINT finished_has_timestamps
  CHECK ((status IN ('succeeded', 'failed', 'dead') AND finished_at IS NOT NULL) 
    OR status IN ('pending', 'processing'));
```

### Field Definitions

| Field | Type | Required | Mutable | Notes |
|-------|------|----------|---------|-------|
| `id` | TEXT | Yes | No | Generated UUID; identifies job across retries |
| `type` | TEXT | Yes | No | Job type enum (e.g., `send_email`, `generate_pdf`, `charge_card`) |
| `payload` | JSONB | Yes | No | Complete input data for work; immutable |
| `status` | TEXT | Yes | Yes | One of: `pending`, `processing`, `succeeded`, `failed`, `dead` |
| `attempts` | INT | Yes | Yes | How many times this job has executed |
| `max_attempts` | INT | Yes | No | When `attempts >= max_attempts`, job goes dead |
| `last_error` | TEXT | No | Yes | Most recent error message (not full stack) |
| `run_at` | TIMESTAMPTZ | Yes | Yes | When worker should next attempt this job |
| `started_at` | TIMESTAMPTZ | No | Yes | When worker claimed this job |
| `finished_at` | TIMESTAMPTZ | No | Yes | When job succeeded or went dead |
| `idempotency_key` | TEXT | Yes | No | Unique; prevents duplicate enqueues of same logical job |
| `created_at` | TIMESTAMPTZ | Yes | No | When job was enqueued |
| `updated_at` | TIMESTAMPTZ | Yes | Yes | Auto-updated on every state change |

---

## 3. Job Lifecycle State Machine

```
┌─────────────────────────────────────────────────┐
│                                                 │
│  PENDING ──(worker claims)──> PROCESSING       │
│     ↑                              │            │
│     │                              │            │
│     └─── (retry backoff) ────<─ FAILED         │
│                                    │            │
│                            (max attempts reached)
│                                    │            │
│                                    └──────> DEAD
│                                              │
│  PENDING ──────> PROCESSING ──────> SUCCEEDED
│                      (work succeeds)
│
└─────────────────────────────────────────────────┘
```

### Status Definitions

**`pending`**
- Initial state after enqueue
- Job is eligible for worker to claim
- `run_at` has passed
- Implies: will retry if it fails

**`processing`**
- Worker has claimed this job, executing work now
- No other worker can claim it (atomic update enforces)
- If worker dies here, stuck job recovery moves it back to `pending`

**`succeeded`**
- Work completed successfully
- `finished_at` is set
- Job done; no further retries

**`failed`**
- Work threw an exception
- `attempts < max_attempts` so will retry
- Backoff delay applied to `run_at`
- Not a terminal state

**`dead`**
- Work exhausted all retries (`attempts >= max_attempts`)
- `finished_at` is set
- Human must investigate and manually retry if needed
- Terminal state—will never retry automatically

---

## 4. Enqueue API

### Endpoint

```
POST /api/v1/jobs
```

### Request

```json
{
  "type": "send_email",
  "payload": {
    "to": "user@example.com",
    "subject": "Welcome",
    "template": "welcome"
  },
  "idempotency_key": "user_123_welcome_onboarding"
}
```

**Fields:**
- `type` (required): Job type identifier
- `payload` (required): Complete input data; can be any JSON
- `idempotency_key` (required): Unique key; same key twice = return existing job

### Response: 202 Accepted

```json
{
  "job_id": "job_550e8400e29b41d4a716446655440000",
  "status": "pending",
  "created_at": "2026-09-25T10:00:00Z"
}
```

**Must return 202, not 200.** This signals "accepted but not done."

### Implementation Rules

1. **Do not execute work in the request handler**
   - Write the job row and return immediately
   - Any work here blocks the HTTP response

2. **Enforce idempotency at the database**
   ```sql
   INSERT INTO jobs (id, type, payload, status, max_attempts, 
                     idempotency_key, run_at, created_at, updated_at)
   VALUES (?, ?, ?, 'pending', ?, ?, NOW(), NOW(), NOW())
   ON CONFLICT (idempotency_key) DO UPDATE
   SET updated_at = NOW()
   RETURNING *;
   ```
   - If key exists, return existing job
   - Do not create a second row

3. **Generate job ID once**
   - Use UUID v4 (not sequential)
   - Prevents enumeration attacks

4. **Set max_attempts from config**
   - Not from request
   - Request cannot override system policy

5. **Set initial run_at to NOW()**
   - Job eligible for worker immediately
   - Unless delayed enqueue is explicit feature

### Error Responses

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing required field: type"
  }
}
```

| Status | Code | When |
|--------|------|------|
| 400 | `INVALID_REQUEST` | Missing type, payload, or idempotency_key |
| 409 | `DUPLICATE_IDEMPOTENCY_KEY` | Same key, different payload (data mismatch) |
| 500 | `DATABASE_ERROR` | DB write failed (log this) |

---

## 5. Worker Implementation

### Worker Process Architecture

```
┌──────────────────────────────┐
│    Worker Process            │
│                              │
│  1. Loop                     │
│  2. Query pending jobs       │
│  3. Claim job atomically     │
│  4. Execute work             │
│  5. Mark succeeded/failed    │
│  6. Return to step 2         │
│                              │
└──────────────────────────────┘
```

### Claiming a Job (Race Condition Prevention)

This is the most critical part. Two workers must never execute the same job.

```sql
UPDATE jobs 
SET status = 'processing', 
    started_at = NOW(),
    updated_at = NOW()
WHERE id = (
  SELECT id FROM jobs 
  WHERE status = 'pending' 
    AND run_at <= NOW()
    AND type = ?
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Why this works:**
- `FOR UPDATE SKIP LOCKED` locks the row and claims it atomically
- Only one worker's UPDATE will succeed (the first one)
- Other workers skip to the next row
- No application-level locking needed

**In code (pseudocode):**
```
FUNCTION claim_job(job_type, concurrency_cap)
  INPUTS: job_type (string), concurrency_cap (integer)
  OUTPUT: job record or null
  SIDE EFFECTS: updates database, marks job as processing
  FAILS WHEN: database unavailable

  1. Count current processing jobs
  2. IF count >= concurrency_cap, RETURN null (at capacity)
  3. CALL database to claim one pending job WHERE type = job_type
  4. IF no row returned, RETURN null (queue empty)
  5. RETURN the claimed job
```

### Executing Work

```
FUNCTION execute_work(job)
  INPUTS: job (record with type, payload, id)
  OUTPUT: result (any type)
  SIDE EFFECTS: calls external system (email, API, file system)
  FAILS WHEN: external system unavailable, work fails

  1. CALL handler function for job.type(job.payload)
  2. IF succeeds, RETURN result
  3. IF throws exception, RETURN error with message
```

**Required:** Work is a pure function taking only `payload`, returning result or throwing.

### Handling Success

```sql
UPDATE jobs 
SET status = 'succeeded', 
    finished_at = NOW(),
    updated_at = NOW()
WHERE id = ?;
```

Done. No further action.

### Handling Failure

When work throws an exception:

```sql
UPDATE jobs 
SET attempts = attempts + 1,
    last_error = ?,
    status = CASE 
      WHEN (attempts + 1) >= max_attempts THEN 'dead'
      ELSE 'pending'
    END,
    run_at = CASE 
      WHEN (attempts + 1) >= max_attempts THEN run_at
      ELSE NOW() + (
        ($1 * POWER(2, attempts)) || ' seconds'
      )::INTERVAL + 
        (RANDOM() * $2)::INTERVAL
    END,
    updated_at = NOW()
WHERE id = ?
RETURNING *;
```

**Parameters:**
- `$1` = `JOB_BACKOFF_BASE_SECONDS` (config)
- `$2` = jitter interval (calculated from `JOB_BACKOFF_JITTER_PERCENT`)

**In pseudocode:**
```
FUNCTION handle_failure(job, error_message)
  INPUTS: job (record), error_message (string)
  OUTPUT: updated job record
  SIDE EFFECTS: updates database
  FAILS WHEN: database unavailable

  1. Increment job.attempts
  2. Store error_message in job.last_error
  3. IF job.attempts >= job.max_attempts
     - Set status = 'dead'
     - Set finished_at = NOW()
  4. ELSE
     - Set status = 'pending'
     - Calculate backoff = base_delay * (2 ^ (attempts - 1)) + jitter
     - Set run_at = NOW() + backoff
  5. WRITE job record to database
  6. RETURN updated job
```

### Worker Main Loop

```
FUNCTION worker_loop()
  INPUTS: none
  OUTPUT: never returns (runs forever)
  SIDE EFFECTS: claims jobs, executes work, updates database
  FAILS WHEN: database connection lost

  LOOP forever:
    1. CALL claim_job(type, JOB_CONCURRENCY_CAP)
    2. IF no job claimed
       - SLEEP JOB_CLAIM_INTERVAL_SECONDS
       - CONTINUE
    3. TRY
       - CALL execute_work(job)
       - CALL handle_success(job)
       - LOG job succeeded
    4. CATCH exception AS error
       - CALL handle_failure(job, error.message)
       - LOG job failed, attempts left, next retry time
    5. END TRY
```

---

## 6. Idempotent Work Requirement

**The rule:** Work can execute twice. You must handle that.

Why: Worker claims job, executes work, then crashes before marking done. On restart, another worker claims the same job and executes again.

### Safe Work

- **Sending email twice**: Bad (user sees two emails)
- **Resizing image twice**: Wasteful but harmless
- **Charging credit card twice**: Unacceptable (illegal)

### Making Work Idempotent

Option A: Check before doing
```javascript
FUNCTION send_email(payload)
  1. CALL email_provider.send({
       to: payload.to,
       subject: payload.subject,
       idempotency_key: job.id  // ← Critical
     })
  2. IF error "message already sent", RETURN (idempotent)
  3. ELSE IF success, RETURN
  4. ELSE THROW error
```

Option B: Store by job ID
```javascript
FUNCTION resize_image(payload)
  1. key = job.id + '_resized'
  2. IF storage.exists(key), RETURN stored result
  3. result = CALL resize_library(payload.image)
  4. WRITE result to storage at key
  5. RETURN result
```

Option C: Database dedupe
```javascript
FUNCTION create_report(payload)
  1. CALL INSERT report WITH ON CONFLICT clause
  2. payload.unique_key must be stored, keyed on job.id
  3. Duplicate insert is no-op
```

**Rule:** Every work handler must document which option it uses.

---

## 7. Stuck Job Recovery

A worker can die mid-job, leaving a row in `processing` forever.

### Recovery Trigger

Scheduled task runs every `JOB_CLEANUP_INTERVAL_SECONDS`:

```sql
UPDATE jobs 
SET status = 'pending', 
    attempts = attempts + 1,
    run_at = NOW(),
    updated_at = NOW()
WHERE status = 'processing' 
  AND started_at < NOW() - INTERVAL '1 hour'
  AND started_at IS NOT NULL
RETURNING id, type, attempts;
```

**Config value:** `JOB_STUCK_TIMEOUT_SECONDS` (default 3600 = 1 hour)

### In Code

```
FUNCTION recover_stuck_jobs()
  INPUTS: none
  OUTPUT: count of recovered jobs
  SIDE EFFECTS: updates database
  FAILS WHEN: database unavailable

  1. QUERY jobs WHERE status = 'processing' 
       AND started_at < (NOW - JOB_STUCK_TIMEOUT_SECONDS)
  2. FOR EACH job
     - Set status = 'pending'
     - Increment attempts
     - Set run_at = NOW()
  3. LOG how many jobs recovered
  4. RETURN count
```

### When to Call

Option 1: Separate recurring process
```bash
# cron job
0 * * * * /app/bin/worker-recover-stuck-jobs
```

Option 2: Worker self-healing (before claiming)
```javascript
async function workerLoop() {
  await recoverStuckJobs();  // Every iteration
  const job = await claimJob();
  // ...
}
```

**Preference:** Option 2 (self-healing). No separate process.

---

## 8. Dead Letter Queue

Jobs with `status = 'dead'` need human investigation.

### Endpoint

```
GET /api/v1/jobs/dead
```

### Response

```json
{
  "jobs": [
    {
      "id": "job_550e8400e29b41d4a716446655440000",
      "type": "send_email",
      "payload": {
        "to": "user@example.com",
        "subject": "Welcome"
      },
      "attempts": 5,
      "max_attempts": 5,
      "last_error": "SMTP: connection timeout after 30s",
      "created_at": "2026-09-25T09:00:00Z",
      "finished_at": "2026-09-25T09:15:00Z"
    }
  ],
  "meta": {
    "total": 42,
    "limit": 20,
    "offset": 0,
    "has_more": true
  }
}
```

### Manual Retry Endpoint

```
POST /api/v1/jobs/:id/retry
```

Response: 202 Accepted

```json
{
  "job_id": "job_550e8400e29b41d4a716446655440000",
  "status": "pending",
  "attempts": 5,
  "max_attempts": 10
}
```

### Implementation

```sql
UPDATE jobs 
SET status = 'pending', 
    max_attempts = ? + 2,  -- Give it 2 more attempts
    run_at = NOW(),
    updated_at = NOW()
WHERE id = ? AND status = 'dead'
RETURNING *;
```

Increment `max_attempts` so job doesn't go dead immediately if it fails again.

---

## 9. Status Endpoint

Client polls this to learn what happened to their job.

### Endpoint

```
GET /api/v1/jobs/:id
```

### Response

```json
{
  "job_id": "job_550e8400e29b41d4a716446655440000",
  "type": "send_email",
  "status": "processing",
  "attempts": 2,
  "max_attempts": 5,
  "last_error": null,
  "run_at": "2026-09-25T10:00:00Z",
  "started_at": "2026-09-25T09:59:30Z",
  "finished_at": null,
  "created_at": "2026-09-25T09:00:00Z",
  "updated_at": "2026-09-25T09:59:30Z"
}
```

### Error Cases

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Job not found"
  }
}
```

Status: 404

---

## 10. Configuration

All numeric values must be in configuration, never hardcoded.

### .env File

```env
# Worker behavior
JOB_CONCURRENCY_CAP=10
JOB_MAX_ATTEMPTS=5
JOB_CLAIM_INTERVAL_SECONDS=2

# Backoff calculation
JOB_BACKOFF_BASE_SECONDS=5
JOB_BACKOFF_JITTER_PERCENT=10

# Stuck job recovery
JOB_STUCK_TIMEOUT_SECONDS=3600
JOB_CLEANUP_INTERVAL_SECONDS=300

# Database
DATABASE_URL=postgresql://user:pass@localhost/jobs_db
```

### .env.example

Commit this (without real credentials):

```env
# How many jobs can this worker process concurrently
JOB_CONCURRENCY_CAP=10

# Maximum retry attempts before a job goes dead
JOB_MAX_ATTEMPTS=5

# How often worker claims jobs (seconds)
JOB_CLAIM_INTERVAL_SECONDS=2

# Exponential backoff: delay = base * (2^attempts) + jitter
JOB_BACKOFF_BASE_SECONDS=5

# Random jitter as percentage of calculated delay
JOB_BACKOFF_JITTER_PERCENT=10

# If worker doesn't update a job for this long, mark it stuck
JOB_STUCK_TIMEOUT_SECONDS=3600

# How often to check for stuck jobs (seconds)
JOB_CLEANUP_INTERVAL_SECONDS=300

# Database connection
DATABASE_URL=
```

### Loading Config

```javascript
const config = {
  concurrencyCap: parseInt(process.env.JOB_CONCURRENCY_CAP || '10'),
  maxAttempts: parseInt(process.env.JOB_MAX_ATTEMPTS || '5'),
  backoffBaseSeconds: parseInt(process.env.JOB_BACKOFF_BASE_SECONDS || '5'),
  backoffJitterPercent: parseInt(process.env.JOB_BACKOFF_JITTER_PERCENT || '10'),
  stuckTimeoutSeconds: parseInt(process.env.JOB_STUCK_TIMEOUT_SECONDS || '3600'),
};

// Validate on startup
if (config.concurrencyCap < 1 || config.concurrencyCap > 100) {
  throw new Error('JOB_CONCURRENCY_CAP must be 1-100');
}
```

---

## 11. Logging & Observability

Every state change must be logged with timestamp and context.

### Log Format

```
[TIMESTAMP] [LEVEL] [WORKER_ID] [JOB_ID] [JOB_TYPE] message

2026-09-25T10:15:23Z INFO worker-1 job_550e8400e29b41d4a716446655440000 send_email Claimed job, attempting
2026-09-25T10:15:45Z INFO worker-1 job_550e8400e29b41d4a716446655440000 send_email Work succeeded
2026-09-25T10:16:00Z INFO worker-1 job_550e8400e29b41d4a716446655440000 send_email Marked succeeded, finished_at set
```

### Required Logs

| Event | Level | Format |
|-------|-------|--------|
| Job claimed | INFO | `Claimed job, attempt N of M` |
| Work started | DEBUG | `Executing work` |
| Work succeeded | INFO | `Work succeeded in Xms` |
| Work failed | WARN | `Work failed: {error}` |
| Retry queued | WARN | `Retry queued, next attempt in Xs` |
| Job dead | ERROR | `Job dead after M attempts, requires manual intervention` |
| Stuck job recovered | WARN | `Recovered stuck job, was in processing for Xs` |
| Worker started | INFO | `Worker started, concurrency cap: N` |
| Worker stopped | INFO | `Worker stopped gracefully` |

### Metrics (Optional but Recommended)

```
jobs.claimed{worker_id, job_type} += 1
jobs.completed{job_type, status} += 1
jobs.duration{job_type} = latency_ms
jobs.attempts{job_type} = attempts_count
jobs.backoff_delay{job_type} = delay_seconds
concurrent_jobs{worker_id} = current_count
dead_letters{job_type} = count
```

---

## 12. Testing Strategy

### Test 1: Concurrency Cap

**Objective:** Prove worker respects max concurrency.

```
Steps:
1. Enqueue 50 jobs of type 'slow_work'
2. Configure JOB_CONCURRENCY_CAP = 5
3. Start worker, watch logs
4. Log shows "concurrent jobs: N" every 5 seconds
5. Verify N never exceeds 5
6. Wait for all jobs to complete
```

**Evidence:** Screenshot of logs showing concurrent count staying ≤ 5.

### Test 2: Exhaustion & Dead State

**Objective:** Job progresses through attempts to dead state.

```
Steps:
1. Create job type that fails 100% of the time
2. Configure JOB_MAX_ATTEMPTS = 3
3. Enqueue 1 job
4. Start worker
5. Monitor job status via GET /api/v1/jobs/:id
```

**Expected timeline:**
```
T+0s    status=pending, attempts=0
T+5s    status=processing (claimed)
T+6s    status=failed, attempts=1, last_error="Error...", run_at=T+11s
T+11s   status=processing (retried)
T+12s   status=failed, attempts=2, run_at=T+22s
T+22s   status=processing (retried)
T+23s   status=dead, attempts=3, finished_at=T+23s
```

**Evidence:** 
- SQL query output showing job record at each stage
- Logs with timestamps
- Screenshot of dead letter queue showing job in it

### Test 3: Stuck Job Recovery

**Objective:** Prove worker recovery restarts stuck jobs.

```
Steps:
1. Enqueue 1 job
2. Start worker
3. Midway through execution, KILL -9 the worker process
4. Job is now stuck in processing (no recovery yet)
5. Wait JOB_CLEANUP_INTERVAL_SECONDS
6. Job should be reset to pending
7. Start worker again
8. Verify job is re-claimed and re-executed
```

**Evidence:**
- Screenshot of job row with status=processing, started_at=(old timestamp)
- Wait > JOB_STUCK_TIMEOUT_SECONDS
- Screenshot of job row with status=pending, attempts=1 (incremented), run_at=NOW()
- Logs showing recovery: "Recovered stuck job"

### Test 4: Idempotency Key Enforcement

**Objective:** Same idempotency key never creates two jobs.

```
Steps:
1. POST /api/v1/jobs with idempotency_key='test_123'
2. Response: job_id=job_abc, status=pending
3. POST /api/v1/jobs with SAME idempotency_key='test_123' and identical payload
4. Response should be: job_id=job_abc (SAME), status=pending
5. Query database: only ONE job exists with that key
```

**Evidence:** 
- Two curl commands with identical idempotency_key
- Response bodies showing same job_id returned both times
- SQL query showing `SELECT COUNT(*) FROM jobs WHERE idempotency_key='test_123'` = 1

### Test 5: Multi-Worker Collision Prevention

**Objective:** Two workers don't claim same job.

```
Steps:
1. Enqueue 10 fast jobs (each work completes instantly)
2. Configure JOB_CONCURRENCY_CAP=2
3. Start 2 workers simultaneously
4. Monitor logs from both workers
5. Verify no job appears in both logs as "Claimed"
6. Verify no job is processed twice (succeeded status appears once)
```

**Evidence:**
- Logs from both workers showing which job each claimed
- No overlap in claimed jobs
- Database showing each job succeeded exactly once
- Both workers processed 5 jobs each (or similar split)

---

## 13. Implementation Checklist

- [ ] Schema created with all indexes
- [ ] Enqueue endpoint returns 202
- [ ] Idempotency key enforced at database
- [ ] Worker claims jobs atomically (FOR UPDATE SKIP LOCKED)
- [ ] Backoff calculation: exponential with jitter
- [ ] Failure handling increments attempts, sets status
- [ ] Dead state reached when attempts >= max_attempts
- [ ] Stuck job recovery runs every cleanup interval
- [ ] All config values in .env, not hardcoded
- [ ] Status endpoint returns job state
- [ ] Dead letter queue shows failed jobs
- [ ] Manual retry endpoint increments max_attempts
- [ ] All logs follow format above
- [ ] Five tests pass with evidence

---

## 14. Deployment Checklist

- [ ] .env.example committed
- [ ] .env NOT committed (add to .gitignore)
- [ ] Database migrations run on deploy
- [ ] Worker process starts as separate service (not in request handler)
- [ ] Worker has JOB_CONCURRENCY_CAP <= available system resources
- [ ] Database has enough connection pool (requests + workers)
- [ ] Stuck job recovery interval set appropriately (suggest: 5 minutes)
- [ ] Dead letter queue is human-accessible (UI or endpoint)
- [ ] Monitoring alerts on jobs entering dead state
- [ ] Worker logs ship to log aggregation (Datadog, LogRocket, etc.)

---

## 15. Defence Questions

**Q: Walk me through exactly how two workers never process the same job.**

A: Worker uses atomic UPDATE with FOR UPDATE SKIP LOCKED. Only one worker's UPDATE will succeed because the row is locked. The first worker to execute the UPDATE claims the job; other workers skip to the next pending job. No application-level locking needed because the database enforces it.

**Q: Your worker crashed after executing work but before marking the job done. What happens when it restarts?**

A: The job is stuck in `processing` status. The recovery sweep runs and finds any job in processing for longer than JOB_STUCK_TIMEOUT_SECONDS. It sets status back to pending, increments attempts, and sets run_at to NOW(). When the worker restarts, it claims the job again. If the work is idempotent (checked before executing), this second run is safe.

**Q: Why jitter? Show me the line.**

A: Without jitter, all jobs that fail at the same moment retry at the same moment. If 100 jobs all hit a failing dependency and retry 1 minute later, they all hit it again at the same time, causing a thundering herd. Jitter spreads them out. The line: `(RANDOM() * $2)::INTERVAL` where $2 is calculated from JOB_BACKOFF_JITTER_PERCENT.

**Q: A job has been in processing for an hour. What does your system do about it and when?**

A: Every JOB_CLEANUP_INTERVAL_SECONDS, the recovery sweep queries for jobs in processing longer than JOB_STUCK_TIMEOUT_SECONDS (default 1 hour). It finds the job, resets it to pending, increments attempts, and sets run_at to NOW(). On the next claim cycle, the worker picks it up and retries.

**Q: What happens if I request page 50 of the dead letter queue but there are only 30 pages?**

A: The endpoint returns HTTP 200 with an empty array in the `jobs` field and `has_more: false` in meta. No error. Graceful degradation.

**Q: How do you prevent a job from being enqueued twice for the same logical action?**

A: Idempotency key, unique at the database level. The same key always returns the existing job. If someone submits the same idempotency key with different payload data, we reject with 409 Conflict.

**Q: Show me where your rate limit number lives and tell me why it lives there.**

A: JOB_CONCURRENCY_CAP in .env. It lives there because different deployments might have different hardware (dev=2, staging=5, prod=20). It's also runtime-tunable without code changes, which is critical for production troubleshooting.

---

## 16. Example Walkthrough

### Scenario: Send Email Job

#### Step 1: Enqueue

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send_email",
    "payload": {
      "to": "alice@example.com",
      "subject": "Welcome",
      "template": "welcome_onboarding",
      "template_vars": {
        "name": "Alice"
      }
    },
    "idempotency_key": "user_alice_welcome"
  }'
```

**Response (202 Accepted):**

```json
{
  "job_id": "job_550e8400e29b41d4a716446655440000",
  "status": "pending",
  "created_at": "2026-09-25T10:00:00Z"
}
```

#### Step 2: Database State

```sql
SELECT * FROM jobs WHERE id = 'job_550e8400e29b41d4a716446655440000';

id                               | type       | status  | attempts | max_attempts | run_at              | started_at | finished_at
---------------------------------|------------|---------|----------|--------------|---------------------|------------|------------
job_550e8400e29b41d4a716446655440000 | send_email | pending | 0        | 5            | 2026-09-25 10:00:00 | NULL       | NULL
```

#### Step 3: Worker Claims

Worker loop:
1. Queries `SELECT id FROM jobs WHERE status='pending' AND run_at <= NOW() LIMIT 1 FOR UPDATE SKIP LOCKED`
2. Claim succeeds:
   ```sql
   UPDATE jobs SET status='processing', started_at=NOW() 
   WHERE id='job_...' 
   RETURNING *;
   ```

#### Step 4: Worker Executes

```javascript
const handler = {
  send_email: async (payload) => {
    const result = await emailProvider.send({
      to: payload.to,
      subject: payload.subject,
      templateId: TEMPLATES[payload.template],
      templateVars: payload.template_vars,
      idempotencyKey: jobId  // ← Idempotency
    });
    return result;
  }
};
```

**If succeeds:**

```sql
UPDATE jobs 
SET status='succeeded', finished_at=NOW() 
WHERE id='job_...';
```

**If fails with "timeout":**

```sql
UPDATE jobs 
SET attempts=1, 
    last_error='SendGrid timeout: 30s',
    status='pending',
    run_at=NOW() + '5 seconds'::INTERVAL + '2.3 seconds'::INTERVAL
WHERE id='job_...';
```

Next log:
```
[2026-09-25T10:00:30Z] WARN worker-1 job_550e8400e29b41d4a716446655440000 send_email 
  Work failed: SendGrid timeout: 30s
  Retry queued, next attempt in 7.3s, attempt 1 of 5
```

---

## 17. README Template

Your repository README should include:

```markdown
# Background Jobs System

Reliable job queue for slow/unreliable work.

## Quick Start

```bash
npm install
cp .env.example .env
npm run migrate
npm start  # Starts worker
```

## Configuration

See `.env.example` for all options.

- `JOB_CONCURRENCY_CAP`: How many jobs to process at once (default 10)
- `JOB_MAX_ATTEMPTS`: Retry limit before dead state (default 5)
- `JOB_BACKOFF_BASE_SECONDS`: Exponential backoff base (default 5)

## Enqueue a Job

```bash
curl -X POST http://localhost:3000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "type": "send_email",
    "payload": { "to": "user@example.com" },
    "idempotency_key": "unique_key_123"
  }'
```

## Check Job Status

```bash
curl http://localhost:3000/api/v1/jobs/job_550e8400e29b41d4a716446655440000
```

## View Dead Letters

```bash
curl http://localhost:3000/api/v1/jobs/dead
```

## Design Decisions

- **Atomic claiming:** Uses SQL FOR UPDATE SKIP LOCKED, not app-level locking
- **Exponential backoff with jitter:** Prevents thundering herd
- **Idempotency key:** Prevents duplicate work for same logical action
- **Separate worker process:** Request handler never does long-running work

## Testing

```bash
npm test  # Run all tests including break-it scenarios
```

See `tests/break-it.test.js` for evidence of:
- Concurrency cap enforcement
- Stuck job recovery
- Exhaustion to dead state
- Idempotency key collision prevention
- Multi-worker collision prevention
```

---

## Document Version

**Task 2 Specification v1.0**
Date: 2026-09-25
Status: Production Ready