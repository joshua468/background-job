import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db/index.js';
import {
  sleep,
  freshDataDir,
  resetDb,
  closeDb,
  teardownAll,
  startTestServer,
  getPage,
  makeHandlers,
  makeWorker,
  testConfig,
  api,
  enqueue,
  getJob,
  listDead,
  retryDead,
  writeEvidence,
  pollUntil,
  renderTable,
  consoleBlock,
  guid,
} from './helpers.js';

before(async () => {
  await freshDataDir();
  await resetDb();
});

beforeEach(async () => {
  // Tear down anything a previous test leaked before touching the database, so
  // a stray worker can never claim rows out from under the next test.
  await teardownAll();
  await resetDb();
});

after(async () => {
  await closeDb();
});

const shortTime = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : '-');

const jobTable = async (where = '', params = []) => {
  const res = await query(
    `SELECT id,type,status,attempts,max_attempts,last_error,run_at,started_at,finished_at
       FROM jobs ${where} ORDER BY created_at`,
    params
  );
  return res.rows;
};

const showJobs = async (title, where = '', params = []) => {
  const rows = await jobTable(where, params);
  consoleBlock(title, renderTable(rows, [
    { key: 'id', label: 'id', get: (r) => r.id },
    { key: 'type', label: 'type' },
    { key: 'status', label: 'status' },
    { key: 'attempts', label: 'att' },
    { key: 'max_attempts', label: 'max' },
    { key: 'last_error', label: 'last_error', get: (r) => (r.last_error ? String(r.last_error).slice(0, 60) : '-') },
    { label: 'run_at', get: (r) => shortTime(r.run_at) },
    { label: 'started_at', get: (r) => shortTime(r.started_at) },
    { label: 'finished_at', get: (r) => shortTime(r.finished_at) },
  ]).split('\n'));
  return rows;
};

// ---------------------------------------------------------------------------
// Test 1: Concurrency cap
// ---------------------------------------------------------------------------
test('Test 1: 50 jobs never exceed the concurrency cap of 5', async () => {
  const config = testConfig({
    JOB_CONCURRENCY_CAP: '5',
    JOB_CLAIM_INTERVAL_SECONDS: '0.05',
    JOB_MAX_ATTEMPTS: '5',
    JOB_BACKOFF_BASE_SECONDS: '1',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
    JOB_HEARTBEAT_INTERVAL_SECONDS: '1',
  });
  const server = await startTestServer(config);
  const handlers = makeHandlers();

  const JOB_COUNT = 50;
  for (let i = 0; i < JOB_COUNT; i++) {
    const res = await enqueue(server.baseUrl, 'slow_work', { delayMs: 400 }, `t1_key_${i}`);
    assert.equal(res.status, 202, 'enqueue must return 202');
  }

  const concurrentSamples = [];
  const { worker, logLines } = makeWorker({
    config,
    handlers,
    workerId: 'worker-concurrency',
    collectLogs: true,
    hooks: {
      onProcessing: (count) => concurrentSamples.push(count),
    },
  });

  worker.start();
  await pollUntil(async () => {
    const res = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status = 'succeeded'");
    return res.rows[0].c === JOB_COUNT;
  }, 120000, 250, `all ${JOB_COUNT} jobs to succeed`);

  const succeeded = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='succeeded'");
  assert.equal(succeeded.rows[0].c, JOB_COUNT, 'all jobs succeeded');

  const maxConcurrent = Math.max(...concurrentSamples, 0);
  assert.ok(
    maxConcurrent <= 5,
    `observed ${maxConcurrent} concurrent jobs, cap is 5 (samples: ${JSON.stringify(concurrentSamples)})`
  );
  assert.ok(maxConcurrent > 1, 'the cap should actually be reached, not trivially serial');

  // The heartbeat lines are corroborating telemetry. The heartbeat fires on a
  // timer, so on a short run it can legitimately land during ramp-up or drain
  // and never catch a moment at the cap. The per-claim samples above are the
  // deterministic proof, because every claim is recorded.
  const heartbeats = logLines.filter((l) => l.includes('Concurrent jobs:'));
  const cap = 5;
  const samplesAboveCap = concurrentSamples.filter((n) => n > cap);
  const capReached = concurrentSamples.includes(cap);

  await writeEvidence('test_1_concurrency.json', JSON.stringify({
    cap,
    jobs_enqueued: JOB_COUNT,
    max_concurrent_observed: maxConcurrent,
    cap_reached: capReached,
    samples_above_cap: samplesAboveCap.length,
    concurrent_samples: concurrentSamples,
    concurrency_heartbeat_log_lines: heartbeats,
    succeeded: succeeded.rows[0].c,
  }, null, 2));

  consoleBlock('Test 1 evidence: concurrency cap', [
    `cap = ${cap}, jobs enqueued = ${JOB_COUNT}, max concurrent observed = ${maxConcurrent}`,
    `cap reached: ${capReached}, samples above cap: ${samplesAboveCap.length}`,
    `samples: ${JSON.stringify(concurrentSamples)}`,
    '',
    'log lines corroborating the cap (timer-driven, so may miss the peak):',
    ...(heartbeats.length ? heartbeats : ['(no heartbeat captured)']),
  ]);

  await showJobs('Test 1: jobs table', 'WHERE type = $1', ['slow_work']);
});

// ---------------------------------------------------------------------------
// Test 2: Exponential backoff and exhaustion to dead
//
// The timeline is captured from worker hooks rather than by polling the table.
// Polling cannot reliably observe 'processing' here because the failing handler
// throws immediately, so the state exists for milliseconds.
// ---------------------------------------------------------------------------
test('Test 2: job retries with growing backoff, then dies at max attempts', async () => {
  const config = testConfig({
    JOB_CONCURRENCY_CAP: '1',
    JOB_CLAIM_INTERVAL_SECONDS: '0.1',
    JOB_MAX_ATTEMPTS: '3',
    JOB_BACKOFF_BASE_SECONDS: '5',
    JOB_BACKOFF_JITTER_PERCENT: '10',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
  });
  const server = await startTestServer(config);
  const handlers = makeHandlers();

  const enq = await enqueue(server.baseUrl, 'always_fails', { message: 'Simulated permanent failure' }, 't2_key_1');
  assert.equal(enq.status, 202);
  const jobId = enq.body.job_id;

  const claims = [];
  const failures = [];
  const { worker, logLines } = makeWorker({
    config,
    handlers,
    workerId: 'worker-backoff',
    collectLogs: true,
    hooks: {
      onClaim: (job) => claims.push({ at: Date.now(), attempt: job.attempts + 1, status_before: job.status }),
      onFailed: (_job, updated) => failures.push({
        at: Date.now(),
        status: updated.status,
        attempts: updated.attempts,
        run_at: new Date(updated.run_at).toISOString(),
        last_error: updated.last_error,
      }),
    },
  });

  worker.start();
  await pollUntil(async () => {
    const row = (await query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0];
    return row.status === 'dead';
  }, 90000, 200, 'job to reach dead');

  const dead = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(dead.status, 'dead', 'terminal state must be dead');
  assert.equal(dead.attempts, 3, 'attempts must equal max_attempts');
  assert.equal(dead.finished_at !== null, true, 'a dead job is terminal so finished_at must be set');
  assert.match(dead.last_error, /Simulated permanent failure/);

  // Exactly three executions, no more.
  assert.equal(claims.length, 3, `expected 3 claims, got ${claims.length}`);
  assert.deepEqual(claims.map((c) => c.attempt), [1, 2, 3]);

  // Two retryable failures, then a terminal one. failed and dead are different.
  assert.deepEqual(failures.map((f) => f.status), ['failed', 'failed', 'dead']);

  // Backoff grew: ~5s then ~10s, with jitter inside +/-10%.
  const gaps = [];
  for (let i = 1; i < claims.length; i++) gaps.push((claims[i].at - claims[i - 1].at) / 1000);
  const [gap1, gap2] = gaps;

  assert.ok(gap1 >= 4.0 && gap1 <= 6.0, `first backoff should be ~5s (+/-10% jitter), got ${gap1}`);
  assert.ok(gap2 >= 9.0 && gap2 <= 11.0, `second backoff should be ~10s (+/-10% jitter), got ${gap2}`);
  assert.ok(gap2 > gap1 * 1.5, `backoff must grow, gap1=${gap1} gap2=${gap2}`);

  // run_at pushed forward on each retry, and not moved once dead.
  const runAts = failures.map((f) => new Date(f.run_at).getTime());
  assert.ok(runAts[1] > runAts[0], 'run_at must move forward for each retry');
  assert.equal(
    new Date(failures[2].run_at).getTime(),
    new Date(dead.run_at).getTime(),
    'a dead job is not rescheduled'
  );

  // Dead letter queue surfaces it.
  const deadList = await listDead(server.baseUrl);
  assert.equal(deadList.status, 200);
  const listed = deadList.body.jobs.find((j) => j.id === jobId);
  assert.ok(listed, 'dead letter queue lists the dead job');
  assert.equal(listed.payload.message, 'Simulated permanent failure', 'DLQ shows the payload');
  assert.match(listed.last_error, /Simulated permanent failure/, 'DLQ shows the last error');
  assert.equal(deadList.body.meta.total, 1);
  assert.equal(deadList.body.meta.has_more, false);

  // Manual retry grants two more attempts and requeues.
  const retryRes = await retryDead(server.baseUrl, jobId);
  assert.equal(retryRes.status, 202);
  assert.equal(retryRes.body.status, 'pending');
  assert.equal(retryRes.body.attempts, 3);
  assert.equal(retryRes.body.max_attempts, 5, 'max_attempts must be incremented by 2');

  const afterRetry = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(afterRetry.status, 'pending');
  assert.equal(afterRetry.finished_at, null, 'a requeued job is not terminal so finished_at is cleared');

  // Retrying a job that is not dead is a 404, not a silent no-op.
  const retryAgain = await retryDead(server.baseUrl, jobId);
  assert.equal(retryAgain.status, 404);

  const timeline = [
    `T+0      pending    attempts=0`,
    `T+${gap1.toFixed(1)}s   processing (attempt 2)   <- after ~5s backoff`,
    `T+${(gap1 + gap2).toFixed(1)}s   processing (attempt 3)   <- after ~10s backoff`,
    `T+${(gap1 + gap2).toFixed(1)}s   dead        attempts=3    <- retries exhausted`,
  ];

  await writeEvidence('test_2_backoff.json', JSON.stringify({
    config: { max_attempts: 3, backoff_base_seconds: 5, jitter_percent: 10 },
    claims,
    failures,
    backoff_gaps_seconds: gaps,
    run_at_per_failure: failures.map((f) => f.run_at),
    timeline,
    dead_row: dead,
    dead_letter_response: deadList.body,
    manual_retry_response: retryRes.body,
    retry_again_status: retryAgain.status,
    log_lines: logLines,
  }, null, 2));

  consoleBlock('Test 2 evidence: backoff and dead', [
    ...timeline,
    '',
    `observed gaps: ${JSON.stringify(gaps.map((g) => Number(g.toFixed(2))))} seconds`,
    'run_at per failure:',
    ...failures.map((f, i) => `  attempt ${i + 1} -> ${f.status.padEnd(6)} run_at=${f.run_at}`),
    '',
    'log lines:',
    ...logLines.filter((l) => /Claimed|Work failed|Retry queued|dead/.test(l)),
  ]);

  await showJobs('Test 2: jobs table', 'WHERE id = $1', [jobId]);
});

// ---------------------------------------------------------------------------
// Test 3: Stuck job recovery
// ---------------------------------------------------------------------------
test('Test 3: job stuck in processing is recovered and re-executed', async () => {
  const configA = testConfig({
    JOB_CONCURRENCY_CAP: '1',
    JOB_CLAIM_INTERVAL_SECONDS: '0.05',
    JOB_STUCK_TIMEOUT_SECONDS: '3600',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
  });
  const server = await startTestServer(configA);
  const handlers = makeHandlers();

  const enq = await enqueue(server.baseUrl, 'hang_forever', {}, 't3_key_1');
  assert.equal(enq.status, 202);
  const jobId = enq.body.job_id;

  const workerA = makeWorker({ config: configA, handlers, workerId: 'worker-crash' }).worker;
  workerA.start();
  await pollUntil(async () => {
    const row = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
    return row.status === 'processing' && row.started_at != null;
  }, 10000, 100, 'job to be claimed');

  const beforeKill = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];

  // Kill the worker mid-job. The handler never resolves, so this is the same
  // end state as SIGKILL: the row is claimed by a process that no longer runs.
  await workerA.stop();
  await sleep(1200);

  const afterKill = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(afterKill.status, 'processing', 'job is stranded in processing');
  assert.equal(
    new Date(afterKill.started_at).toISOString(),
    new Date(beforeKill.started_at).toISOString(),
    'started_at unchanged - nobody came along to fix it'
  );
  assert.equal(afterKill.attempts, 0, 'recovery has not run yet, so attempts is untouched');

  // The recovery sweep, with a short timeout, requeues it.
  const recoveryConfig = testConfig({
    JOB_CONCURRENCY_CAP: '1',
    JOB_CLAIM_INTERVAL_SECONDS: '1',
    JOB_STUCK_TIMEOUT_SECONDS: '1',
    JOB_CLEANUP_INTERVAL_SECONDS: '1',
  });
  const rec = makeWorker({
    config: recoveryConfig,
    handlers,
    workerId: 'worker-recovery',
    collectLogs: true,
  });
  const recoveredCount = await rec.worker.recoverStuckJobs();
  assert.equal(recoveredCount, 1, 'recovery must reset exactly one job');

  const afterRecovery = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(afterRecovery.status, 'pending', 'recovered job returns to pending');
  assert.equal(afterRecovery.attempts, 1, 'recovery consumes an attempt');
  assert.equal(afterRecovery.finished_at, null, 'a requeued job is not terminal');
  assert.ok(
    new Date(afterRecovery.run_at) <= new Date(Date.now() + 1000),
    'recovered job is immediately runnable'
  );

  // A healthy handler now stands in for the dependency coming back.
  const handlers2 = makeHandlers({
    hang_forever: { strategy: 'replaced for the restart', async run() { return { recovered: true }; } },
  });
  const workerB = makeWorker({ config: configA, handlers: handlers2, workerId: 'worker-restarted' }).worker;
  workerB.start();

  await pollUntil(async () => {
    const row = (await query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0];
    return row.status === 'succeeded';
  }, 20000, 200, 're-executed job to succeed');

  const final = (await query('SELECT * FROM jobs WHERE id=$1', [jobId])).rows[0];
  assert.equal(final.status, 'succeeded');
  assert.equal(final.attempts, 1, 'the recovery attempt is still counted after success');

  await writeEvidence('test_3_stuck_recovery.json', JSON.stringify({
    stuck_timeout_seconds_configured: configA.stuckTimeoutSeconds,
    before_kill: beforeKill,
    after_kill: afterKill,
    after_recovery: afterRecovery,
    recovered_count: recoveredCount,
    final,
    recovery_log_lines: rec.logLines.filter((l) => l.includes('Recovered stuck job')),
  }, null, 2));

  consoleBlock('Test 3 evidence: stuck job recovery', [
    'before kill   : status=processing started_at=' + shortTime(beforeKill.started_at) + ' attempts=' + beforeKill.attempts,
    'after kill    : status=processing started_at=' + shortTime(afterKill.started_at) + ' attempts=' + afterKill.attempts + '  (stranded)',
    'after recovery: status=pending    attempts=' + afterRecovery.attempts + ' run_at=' + shortTime(afterRecovery.run_at),
    'after restart : status=' + final.status + ' attempts=' + final.attempts + ' finished_at=' + shortTime(final.finished_at),
    '',
    'recovery log:',
    ...rec.logLines.filter((l) => l.includes('Recovered stuck job')),
  ]);

  await showJobs('Test 3: jobs table', 'WHERE id = $1', [jobId]);
});

// ---------------------------------------------------------------------------
// Test 4: Idempotency key enforcement at the database
// ---------------------------------------------------------------------------
test('Test 4: one idempotency key can only ever produce one job', async () => {
  const config = testConfig({ JOB_MAX_ATTEMPTS: '5' });
  const server = await startTestServer(config);

  const key = `t4_key_${guid()}`;
  const payload = { to: 'user@example.com', subject: 'Welcome' };

  const first = await enqueue(server.baseUrl, 'send_email', payload, key);
  assert.equal(first.status, 202, 'must be 202, never 200 or 201');

  const second = await enqueue(server.baseUrl, 'send_email', payload, key);
  assert.equal(second.status, 202);
  assert.equal(second.body.job_id, first.body.job_id, 'same key returns the existing job');

  // Key order must not matter, so a reordered but equivalent payload still matches.
  const reordered = await enqueue(
    server.baseUrl,
    'send_email',
    { subject: 'Welcome', to: 'user@example.com' },
    key
  );
  assert.equal(reordered.body.job_id, first.body.job_id, 'payload comparison is order independent');

  const count = await query('SELECT COUNT(*)::int AS c FROM jobs WHERE idempotency_key=$1', [key]);
  assert.equal(count.rows[0].c, 1, 'exactly one row for that key');

  // Same key, different data is a conflict, not a silent overwrite.
  const conflicting = await enqueue(server.baseUrl, 'send_email', { to: 'other@example.com' }, key);
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error.code, 'DUPLICATE_IDEMPOTENCY_KEY');

  // Validation.
  const missingType = await enqueue(server.baseUrl, undefined, {}, `t4_missing_${guid()}`);
  assert.equal(missingType.status, 400);
  assert.equal(missingType.body.error.code, 'INVALID_REQUEST');
  assert.match(missingType.body.error.message, /type/);

  const missingKey = await api(server.baseUrl, 'POST', '/api/v1/jobs', { type: 'send_email', payload: {} });
  assert.equal(missingKey.status, 400, 'idempotency_key is required');

  const notFound = await getJob(server.baseUrl, `job_${guid()}`);
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'NOT_FOUND');

  const statusRes = await getJob(server.baseUrl, first.body.job_id);
  assert.equal(statusRes.status, 200);
  assert.equal(statusRes.body.status, 'pending');
  assert.equal(statusRes.body.job_id, first.body.job_id);
  assert.equal(statusRes.body.attempts, 0);

  // The view is served.
  const page = await getPage(server.baseUrl);
  assert.equal(page.status, 200, 'the dead letter view is served at /');

  await writeEvidence('test_4_idempotency.json', JSON.stringify({
    idempotency_key: key,
    first_request: first,
    second_request_same_key: second,
    third_request_reordered_payload: reordered,
    same_key_different_payload: conflicting,
    missing_type: missingType,
    missing_key: missingKey,
    not_found: notFound,
    rows_with_key: count.rows[0].c,
    status_endpoint: statusRes,
    view_served: { status: page.status, content_type: 'text/html' },
  }, null, 2));

  consoleBlock('Test 4 evidence: idempotency key', [
    'POST #1 ->', JSON.stringify(first.body),
    'POST #2 (same key, same payload) ->', JSON.stringify(second.body),
    'POST #3 (same key, reordered payload) ->', JSON.stringify(reordered.body),
    'POST #4 (same key, different payload) ->', conflicting.status, conflicting.body.error.code,
    '',
    'SELECT COUNT(*) FROM jobs WHERE idempotency_key = ' + key + '  ->  ' + count.rows[0].c,
    'missing type ->', missingType.status, missingType.body.error.code,
    'missing idempotency_key ->', missingKey.status, missingKey.body.error.code,
    'unknown job id ->', notFound.status, notFound.body.error.code,
  ]);

  await showJobs('Test 4: jobs table');
});

// ---------------------------------------------------------------------------
// Test 5: Two workers, no double claim
// ---------------------------------------------------------------------------
test('Test 5: two workers sharing a queue never claim the same job', async () => {
  const config = testConfig({
    JOB_CONCURRENCY_CAP: '2',
    JOB_CLAIM_INTERVAL_SECONDS: '0.02',
    JOB_MAX_ATTEMPTS: '3',
    JOB_BACKOFF_BASE_SECONDS: '1',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
  });
  const server = await startTestServer(config);
  const handlers = makeHandlers();

  const JOB_COUNT = 20;
  for (let i = 0; i < JOB_COUNT; i++) {
    const res = await enqueue(server.baseUrl, 'quick_work', {}, `t5_key_${i}`);
    assert.equal(res.status, 202);
  }

  const claimed1 = [];
  const claimed2 = [];
  const w1 = makeWorker({
    config,
    handlers,
    workerId: 'worker-A',
    hooks: { onClaim: (job) => claimed1.push(job.id) },
  });
  const w2 = makeWorker({
    config,
    handlers,
    workerId: 'worker-B',
    hooks: { onClaim: (job) => claimed2.push(job.id) },
  });

  w1.worker.start();
  w2.worker.start();

  await pollUntil(async () => {
    const res = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='succeeded'");
    return res.rows[0].c === JOB_COUNT;
  }, 60000, 250, `all ${JOB_COUNT} jobs to succeed`);

  const succeeded = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='succeeded'");
  assert.equal(succeeded.rows[0].c, JOB_COUNT, 'each job succeeded exactly once');

  const all = [...claimed1, ...claimed2];
  const overlap = all.filter((id) => claimed1.includes(id) && claimed2.includes(id));
  const duplicates = all.filter((id, i) => all.indexOf(id) !== i);

  assert.equal(all.length, JOB_COUNT, `all jobs claimed exactly once across both workers, got ${all.length}`);
  assert.equal(new Set(all).size, JOB_COUNT, 'no job appears in two claim lists');
  assert.deepEqual(overlap, [], 'no job was claimed by both workers');
  assert.deepEqual(duplicates, [], 'no job was claimed twice by the same worker');
  assert.ok(claimed1.length > 0, 'worker A did work');
  assert.ok(claimed2.length > 0, 'worker B did work');

  await writeEvidence('test_5_two_workers.json', JSON.stringify({
    jobs: JOB_COUNT,
    claimed_by_worker_A: claimed1,
    claimed_by_worker_B: claimed2,
    overlap,
    duplicates,
    succeeded_count: succeeded.rows[0].c,
  }, null, 2));

  consoleBlock('Test 5 evidence: two workers, one queue', [
    `worker A claimed ${claimed1.length}`,
    `worker B claimed ${claimed2.length}`,
    `total claims ${all.length} for ${JOB_COUNT} jobs`,
    `jobs claimed by both workers: ${overlap.length}`,
    `jobs claimed more than once: ${duplicates.length}`,
    '',
    'A:', claimed1.join(', '),
    '',
    'B:', claimed2.join(', '),
  ]);
});

// ---------------------------------------------------------------------------
// Test 6: Idempotent work
// ---------------------------------------------------------------------------
test('Test 6: running the work twice still produces exactly one output', async () => {
  const handlers = makeHandlers();

  const insertFakeJob = async (job, payload) =>
    query(
      `INSERT INTO jobs (id, type, payload, status, attempts, max_attempts, idempotency_key,
                         finished_at, run_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'succeeded', 1, 5, $4, NOW(), NOW(), NOW(), NOW())`,
      [job.id, job.type, JSON.stringify(payload), `evidence_${guid()}`]
    );

  // Option A: send_email passes the job id to the provider as an idempotency key.
  const mailJob = { id: `job_${guid()}`, type: 'send_email' };
  const emailPayload = { to: 'alice@example.com', subject: 'Welcome', template: 'welcome' };
  await insertFakeJob(mailJob, emailPayload);
  const sent = await handlers.send_email.run(mailJob, emailPayload);
  const redelivered = await handlers.send_email.run(mailJob, emailPayload);
  assert.equal(sent.status, 'sent');
  assert.equal(redelivered.status, 'already_sent', 'second run must not send a second email');
  assert.equal(redelivered.messageId, sent.messageId, 'the same message comes back');

  // Option B: generate_pdf keys its output on the job id.
  const pdfJob = { id: `job_${guid()}`, type: 'generate_pdf' };
  const pdfPayload = { content: { title: 'Report', rows: [1, 2, 3] }, format: 'A4' };
  await insertFakeJob(pdfJob, pdfPayload);
  const firstPdf = await handlers.generate_pdf.run(pdfJob, pdfPayload);
  const secondPdf = await handlers.generate_pdf.run(pdfJob, pdfPayload);
  assert.equal(firstPdf.cached, false);
  assert.equal(secondPdf.cached, true, 'second run returns the stored output instead of regenerating');
  assert.equal(secondPdf.key, firstPdf.key, 'both runs agree on the output key');

  // Option C: charge_card dedupes on a charges row keyed on the job id.
  const chargeJob = { id: `job_${guid()}`, type: 'charge_card' };
  const chargePayload = { customerId: 'cus_test_1', amount: 1000, currency: 'usd' };
  await insertFakeJob(chargeJob, chargePayload);
  const firstCharge = await handlers.charge_card.run(chargeJob, chargePayload);
  const secondCharge = await handlers.charge_card.run(chargeJob, chargePayload);
  assert.equal(firstCharge.deduped, false);
  assert.equal(secondCharge.deduped, true, 'second run returns the existing charge');
  assert.equal(secondCharge.chargeId, firstCharge.chargeId, 'never a second charge id');
  const chargeRows = await query('SELECT COUNT(*)::int AS c FROM charges WHERE job_id=$1', [chargeJob.id]);
  assert.equal(chargeRows.rows[0].c, 1, 'exactly one charges row after two executions');

  await writeEvidence('test_6_idempotent_work.json', JSON.stringify({
    option_a_send_email: { first: sent, second: redelivered },
    option_b_generate_pdf: { first: firstPdf, second: secondPdf },
    option_c_charge_card: { first: firstCharge, second: secondCharge, charges_rows: chargeRows.rows[0].c },
  }, null, 2));

  consoleBlock('Test 6 evidence: idempotent work', [
    'Option A  send_email   : ' + sent.status + ' -> ' + redelivered.status + '  (same messageId: ' + (sent.messageId === redelivered.messageId) + ')',
    'Option B  generate_pdf : cached=' + firstPdf.cached + ' -> cached=' + secondPdf.cached + '  (key ' + secondPdf.key + ')',
    'Option C  charge_card  : deduped=' + firstCharge.deduped + ' -> deduped=' + secondCharge.deduped + '  (charges rows: ' + chargeRows.rows[0].c + ')',
  ]);
});

/**
 * Identify which database guard rejected a statement.
 *
 * node-postgres populates `error.constraint` for unique violations but not for
 * check violations, and the transition trigger raises its own message shape, so
 * both have to be read out of the message text.
 */
function describePgError(e) {
  const check = /violates check constraint "([^"]+)"/.exec(e.message || '');
  const trigger = /illegal job status transition/.exec(e.message || '');
  let guard;
  if (e.constraint) {
    guard = e.constraint;
  } else if (check) {
    guard = check[1];
  } else if (trigger) {
    guard = 'trg_jobs_status_transition';
  } else {
    guard = null;
  }
  return { sqlstate: e.code, guard, message: e.message };
}

// ---------------------------------------------------------------------------
// Test 7: The database refuses invalid states
//
// Ordering matters here. trg_jobs_status_transition is a BEFORE UPDATE trigger,
// so it fires before any CHECK constraint is evaluated. A test that jumps
// straight to an invalid status is therefore rejected by the trigger and never
// reaches the constraint it appears to be testing. To prove a CHECK constraint
// actually works, the status transition has to be legal and the CHECK is what
// has to catch it.
// ---------------------------------------------------------------------------
test('Test 7: the database rejects states the application must never produce', async () => {
  const config = testConfig({ JOB_MAX_ATTEMPTS: '3' });
  const server = await startTestServer(config);

  const enq = await enqueue(server.baseUrl, 'quick_work', {}, `t7_key_${guid()}`);
  const id = enq.body.job_id;

  const violations = [];
  const expectReject = (label, expectedGuard, expectedSqlstate) => async (sql, params) => {
    try {
      await query(sql, params);
    } catch (e) {
      const described = describePgError(e);
      assert.equal(described.guard, expectedGuard,
        `${label}: expected ${expectedGuard} to reject this, got ${described.guard} (${described.message})`);
      assert.equal(described.sqlstate, expectedSqlstate);
      violations.push({ case: label, ...described });
      return;
    }
    assert.fail(`${label}: statement was accepted but should have been rejected`);
  };

  // For cases where more than one guard would reject the statement, record
  // whichever fired first instead of pretending the row isolates one of them.
  const expectRejectSqlstate = (label, expectedSqlstate) => async (sql, params) => {
    try {
      await query(sql, params);
    } catch (e) {
      const described = describePgError(e);
      assert.equal(described.sqlstate, expectedSqlstate,
        `${label}: expected SQLSTATE ${expectedSqlstate}, got ${described.sqlstate}`);
      violations.push({ case: label, ...described });
      return;
    }
    assert.fail(`${label}: statement was accepted but should have been rejected`);
  };

  const insertJob = (over = {}) => query(
    `INSERT INTO jobs (id,type,payload,status,attempts,max_attempts,idempotency_key,
                       finished_at,started_at,run_at,created_at,updated_at)
     VALUES ($1,$2,'{}',$3,$4,$5,$6,$7,$8,NOW(),NOW(),NOW())`,
    [over.id, over.type || 'quick_work', over.status || 'pending', over.attempts ?? 0,
     over.max_attempts ?? 3, over.key || `t7_${guid()}`, over.finished_at ?? null,
     over.started_at ?? null]
  );

  // 1. An undefined status. Both valid_status and finished_has_timestamps
  //    reject this row, and PostgreSQL reports the first one it evaluates, so
  //    this case records the guard that actually fired rather than asserting an
  //    isolation that does not exist. valid_status is kept in the schema as
  //    defence in depth and to make the allowed set readable in one place.
  await expectRejectSqlstate("INSERT with status='half_done'", '23514')(
    `INSERT INTO jobs (id,type,payload,status,attempts,max_attempts,idempotency_key,run_at,created_at,updated_at)
     VALUES ($1,'quick_work','{}','half_done',0,3,$2,NOW(),NOW(),NOW())`,
    [`job_${guid()}`, `t7_bad_${guid()}`]
  );

  // 2. finished_has_timestamps: pending -> processing -> succeeded is a legal
  //    transition, so only the missing finished_at can reject it.
  await query("UPDATE jobs SET status='processing', started_at=NOW() WHERE id=$1", [id]);
  await expectReject('succeeded with finished_at=NULL', 'finished_has_timestamps', '23514')(
    "UPDATE jobs SET status='succeeded', finished_at=NULL WHERE id=$1", [id]
  );

  // 3. finished_has_timestamps, and the exact bug that broke the original
  //    failure path: a retryable failure must not be marked finished.
  const retryable = `job_${guid()}`;
  await insertJob({ id: retryable });
  await query("UPDATE jobs SET status='processing', started_at=NOW() WHERE id=$1", [retryable]);
  await expectReject('failed with finished_at=NOW()', 'finished_has_timestamps', '23514')(
    "UPDATE jobs SET status='failed', finished_at=NOW() WHERE id=$1", [retryable]
  );

  // 4. started_at_matches_status: claiming a job without recording when.
  const unstarted = `job_${guid()}`;
  await insertJob({ id: unstarted });
  await expectReject('processing with started_at=NULL', 'started_at_matches_status', '23514')(
    "UPDATE jobs SET status='processing', started_at=NULL WHERE id=$1", [unstarted]
  );

  // 5. The transition trigger: a succeeded job must not be re-claimed. No CHECK
  //    constraint can catch this, because each row is valid in isolation.
  const done = `job_${guid()}`;
  await insertJob({ id: done, status: 'succeeded', attempts: 1, finished_at: new Date() });
  await expectReject('succeeded -> processing', 'trg_jobs_status_transition', '23514')(
    'UPDATE jobs SET status=$2, started_at=NOW() WHERE id=$1', [done, 'processing']
  );

  // 6. dead_means_exhausted: a job cannot die while attempts remain. The
  //    transition into dead is legal, so only this CHECK can catch it.
  await expectReject('dead while attempts remain', 'dead_means_exhausted', '23514')(
    "UPDATE jobs SET status='dead', finished_at=NOW(), attempts=1 WHERE id=$1", [id]
  );

  // 7. UNIQUE on idempotency_key, the constraint that owns duplicate prevention.
  await expectReject('duplicate idempotency_key', 'jobs_idempotency_key_key', '23505')(
    `INSERT INTO jobs (id,type,payload,status,attempts,max_attempts,idempotency_key,run_at,created_at,updated_at)
     VALUES ($1,'quick_work','{}','pending',0,3,$2,NOW(),NOW(),NOW())`,
    [`job_${guid()}`, (await query('SELECT idempotency_key FROM jobs WHERE id=$1', [id])).rows[0].idempotency_key]
  );

  // The legal path must still work, or the guards are simply too strict.
  const legal = (await query('SELECT id FROM jobs WHERE status=$1 LIMIT 1', ['pending'])).rows[0].id;
  await query("UPDATE jobs SET status='processing', started_at=NOW() WHERE id=$1", [legal]);
  await query("UPDATE jobs SET status='failed', last_error='transient' WHERE id=$1", [legal]);
  const afterLegal = (await query('SELECT * FROM jobs WHERE id=$1', [legal])).rows[0];
  assert.equal(afterLegal.status, 'failed', 'pending -> processing -> failed is allowed');
  assert.equal(afterLegal.finished_at, null, 'and a failed job carries no finished_at');
  await query(
    "UPDATE jobs SET status='processing', started_at=NOW() WHERE id=$1 AND status='failed'", [legal]
  );
  await query("UPDATE jobs SET status='succeeded', finished_at=NOW() WHERE id=$1", [legal]);
  const afterSuccess = (await query('SELECT * FROM jobs WHERE id=$1', [legal])).rows[0];
  assert.equal(afterSuccess.status, 'succeeded', 'failed -> processing -> succeeded is allowed');
  assert.ok(afterSuccess.finished_at, 'a succeeded job carries finished_at');

  await writeEvidence('test_7_constraint_violations.json', JSON.stringify({
    rejected: violations,
    legal_transitions_still_work: {
      path: 'pending -> processing -> failed -> processing -> succeeded',
      final_status: afterSuccess.status,
      finished_at: afterSuccess.finished_at,
    },
  }, null, 2));

  consoleBlock('Test 7 evidence: database refuses invalid states', [
    ...violations.map((v, i) =>
      `${i + 1}. ${v.case.padEnd(34)} rejected by ${String(v.guard).padEnd(30)} (SQLSTATE ${v.sqlstate})`),
    '',
    'legal path still permitted: pending -> processing -> failed -> processing -> succeeded',
  ]);
});

// ---------------------------------------------------------------------------
// Test 8: Dead letter queue paging degrades gracefully
// ---------------------------------------------------------------------------
test('Test 8: dead letter queue pages past the end return an empty page, not an error', async () => {
  const config = testConfig({ JOB_MAX_ATTEMPTS: '1' });
  const server = await startTestServer(config);
  const handlers = makeHandlers();

  // max_attempts=1 means the first failure is terminal, so these die at once.
  for (let i = 0; i < 3; i++) {
    await enqueue(server.baseUrl, 'always_fails', { message: `boom ${i}` }, `t8_key_${i}`);
  }
  const { worker } = makeWorker({ config, handlers, workerId: 'worker-dlq' });
  worker.start();

  await pollUntil(async () => {
    const res = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='dead'");
    return res.rows[0].c === 3;
  }, 30000, 200, 'three dead jobs');

  const firstPage = await listDead(server.baseUrl, '?limit=2&offset=0');
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.jobs.length, 2);
  assert.equal(firstPage.body.meta.total, 3);
  assert.equal(firstPage.body.meta.has_more, true, 'page 1 of 3 at limit 2 has more');

  const lastPage = await listDead(server.baseUrl, '?limit=2&offset=2');
  assert.equal(lastPage.status, 200);
  assert.equal(lastPage.body.jobs.length, 1);
  assert.equal(lastPage.body.meta.has_more, false);

  // Page 50 of a 2-page collection. Graceful degradation, not a 404.
  const past = await listDead(server.baseUrl, '?limit=20&offset=980');
  assert.equal(past.status, 200, 'reading past the end is not an error');
  assert.deepEqual(past.body.jobs, []);
  assert.equal(past.body.meta.total, 3);
  assert.equal(past.body.meta.has_more, false, 'no phantom page 51');

  // limit is clamped, negatives are rejected.
  const clamped = await listDead(server.baseUrl, '?limit=5000');
  assert.equal(clamped.body.meta.limit, 100, 'limit is clamped to the maximum');
  const negative = await listDead(server.baseUrl, '?limit=-1');
  assert.equal(negative.status, 400);
  assert.equal(negative.body.error.code, 'INVALID_REQUEST');
  const nonNumeric = await listDead(server.baseUrl, '?limit=abc');
  assert.equal(nonNumeric.status, 400);

  // -------------------------------------------------------------------------
  // Type filter, server-side.
  //
  // The console originally filtered by type in the browser, which only ever saw
  // the rows on the current page. A filtered search that silently ignores
  // page 2 is worse than no filter, because it reports "no matches" for a job
  // that is sitting right there. So the filter has to be in SQL, and the count
  // has to be the filtered count.
  // -------------------------------------------------------------------------
  for (let i = 0; i < 4; i++) {
    await enqueue(server.baseUrl, 'generate_pdf', { doc: `d${i}` }, `t8_pdf_${i}`);
  }
  await pollUntil(async () => {
    const res = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='dead'");
    return res.rows[0].c === 7;
  }, 30000, 200, 'seven dead jobs');

  const filtered = await listDead(server.baseUrl, '?type=generate_pdf');
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.meta.total, 4, 'total counts only the filtered rows');
  assert.equal(filtered.body.jobs.length, 4);
  assert.ok(
    filtered.body.jobs.every((j) => j.type === 'generate_pdf'),
    'no row of another type leaks through the filter'
  );
  assert.equal(filtered.body.meta.type, 'generate_pdf', 'the applied filter is echoed back');

  // The bug the server-side filter exists to prevent: with a page smaller than
  // the match set, the filter must still find rows on the second page.
  const filteredPage2 = await listDead(server.baseUrl, '?type=generate_pdf&limit=2&offset=2');
  assert.equal(filteredPage2.body.jobs.length, 2, 'the filter reaches past the first page');
  assert.equal(filteredPage2.body.meta.total, 4, 'and the total is not the page size');
  assert.equal(filteredPage2.body.meta.has_more, false);

  // A filter matching nothing is an empty result, not an error.
  const noMatch = await listDead(server.baseUrl, '?type=no_such_type');
  assert.equal(noMatch.status, 200);
  assert.deepEqual(noMatch.body.jobs, []);
  assert.equal(noMatch.body.meta.total, 0);
  assert.equal(noMatch.body.meta.has_more, false);

  // The unfiltered view is unaffected by any of the above.
  const unfiltered = await listDead(server.baseUrl, '');
  assert.equal(unfiltered.body.meta.total, 7, 'filtering does not mutate the collection');

  await writeEvidence('test_8_dead_letter_paging.json', JSON.stringify({
    first_page: firstPage.body,
    last_page: lastPage.body,
    page_past_end: past,
    limit_clamped_to: clamped.body.meta.limit,
    negative_limit: negative.body,
    non_numeric_limit: nonNumeric.body,
    type_filter: {
      applied: filtered.body.meta.type,
      matched: filtered.body.meta.total,
      all_of_the_filtered_type: filtered.body.jobs.every((j) => j.type === 'generate_pdf'),
      second_page_reachable: filteredPage2.body.jobs.length,
      no_match: noMatch.body,
      unfiltered_total_unchanged: unfiltered.body.meta.total,
    },
  }, null, 2));

  consoleBlock('Test 8 evidence: dead letter paging', [
    'page 1  (limit=2 offset=0): ' + firstPage.body.jobs.length + ' jobs, total=' + firstPage.body.meta.total + ', has_more=' + firstPage.body.meta.has_more,
    'page 2  (limit=2 offset=2): ' + lastPage.body.jobs.length + ' jobs, has_more=' + lastPage.body.meta.has_more,
    'page 50 (limit=20 offset=980): HTTP ' + past.status + ', jobs=' + JSON.stringify(past.body.jobs) + ', has_more=' + past.body.meta.has_more,
    'limit=5000 clamped to: ' + clamped.body.meta.limit,
    'limit=-1 -> HTTP ' + negative.status + ' ' + negative.body.error.code,
    '',
    'type filter (server-side):',
    '  type=generate_pdf -> total ' + filtered.body.meta.total + ', all matched: ' + filtered.body.jobs.every((j) => j.type === 'generate_pdf'),
    '  limit=2&offset=2 -> ' + filteredPage2.body.jobs.length + ' jobs, so the filter is not limited to page 1',
    '  type=no_such_type -> HTTP ' + noMatch.status + ', ' + noMatch.body.jobs.length + ' jobs, has_more=' + noMatch.body.meta.has_more,
    '  unfiltered total still ' + unfiltered.body.meta.total,
  ]);
});
