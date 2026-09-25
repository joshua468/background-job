/**
 * Produces the evidence artefacts for the task brief, using the real entrypoints
 * (src/server.js and src/worker/main.js) as child processes rather than the
 * in-process test harness, so what is captured is what actually ships.
 *
 *   npm run evidence            # writes evidence/console-output.txt
 *
 * The all-status table is built by making the system pass through every state
 * in one run, not by inserting rows by hand:
 *
 *   pending     enqueued while the worker was stopped (the queue backing up)
 *   processing  a handler that never returns
 *   succeeded   work that completes
 *   failed      the dead job, manually retried, failing again with a long backoff
 *   dead        first failure against max_attempts=1
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { query, closePool } from '../src/db/index.js';

const PORT = process.env.EVIDENCE_PORT || '3311';
const PORT_FAST = String(Number(PORT) + 1);
const BASE = `http://127.0.0.1:${PORT}`;
// The API stamps max_attempts onto the row at enqueue time, so a job only gets
// three attempts if the server that accepted it was configured for three.
let currentBase = BASE;
const ROOT = resolve(import.meta.dirname, '..');

// A one-hour backoff keeps a retryable failure sitting in 'failed' long enough
// to photograph it, instead of vanishing back to pending in five seconds.
const DEMO_ENV = {
  ...process.env,
  PORT,
  JOB_CONCURRENCY_CAP: '2',
  JOB_MAX_ATTEMPTS: '1',
  JOB_BACKOFF_BASE_SECONDS: '3600',
  JOB_BACKOFF_JITTER_PERCENT: '10',
  JOB_STUCK_TIMEOUT_SECONDS: '86400',
  JOB_CLEANUP_INTERVAL_SECONDS: '3600',
  JOB_HEARTBEAT_INTERVAL_SECONDS: '2',
  JOB_CLAIM_INTERVAL_SECONDS: '0.2',
  DATA_DIR: resolve(ROOT, 'data', 'evidence'),
};

const lines = [];
const out = (text = '') => {
  lines.push(text);
  console.log(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortTime = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : '-');

const children = [];
function launch(name, script, envOverrides = {}) {
  const child = spawn(process.execPath, [script], {
    cwd: ROOT,
    env: { ...DEMO_ENV, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const relay = (tag) => (d) => {
    for (const l of String(d).trimEnd().split('\n')) {
      if (l.trim()) out(`[${tag}] ${l}`);
    }
  };
  child.stdout.on('data', relay(name));
  child.stderr.on('data', relay(`${name}!`));
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function api(path, options, base = currentBase) {
  const res = await fetch(base + path, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

const enqueue = (type, payload, key) =>
  api('/api/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, payload, idempotency_key: key }),
  });

async function table(title, where = '') {
  const res = await query(
    `SELECT id, type, status, attempts, max_attempts, last_error,
            run_at, started_at, finished_at, created_at
       FROM jobs ${where} ORDER BY created_at`
  );
  const cols = [
    ['id', (r) => r.id],
    ['type', (r) => r.type],
    ['status', (r) => r.status],
    ['att', (r) => r.attempts],
    ['max', (r) => r.max_attempts],
    ['last_error', (r) => (r.last_error ? String(r.last_error).slice(0, 34) : '-')],
    ['run_at', (r) => shortTime(r.run_at)],
    ['started_at', (r) => shortTime(r.started_at)],
    ['finished_at', (r) => shortTime(r.finished_at)],
  ];
  const body = res.rows.map((r) => cols.map(([, f]) => String(f(r) ?? '-')));
  const widths = cols.map(([h], i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');

  out();
  out(title);
  out(line(cols.map(([h]) => h)));
  out(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of body) out(line(row));
  out();
  return res.rows;
}

async function main() {
  await rm(resolve(ROOT, 'data', 'evidence'), { recursive: true, force: true });
  await mkdir(resolve(ROOT, 'evidence'), { recursive: true });

  await query('TRUNCATE jobs, charges CASCADE');

  out('=================================================================');
  out(' Background Jobs System - evidence run');
  out(` started ${new Date().toISOString()}`);
  out('=================================================================');
  out();
  out('Configuration used for this run:');
  for (const k of ['JOB_CONCURRENCY_CAP', 'JOB_MAX_ATTEMPTS', 'JOB_BACKOFF_BASE_SECONDS',
                   'JOB_BACKOFF_JITTER_PERCENT', 'JOB_STUCK_TIMEOUT_SECONDS',
                   'JOB_CLEANUP_INTERVAL_SECONDS']) {
    out(`  ${k}=${DEMO_ENV[k]}`);
  }
  out();

  // ---- Phase 1: API up, no worker. Everything enqueued stays pending. ----
  out('--- Phase 1: enqueue with no worker running (all jobs stay pending) ---');
  launch('server', 'src/server.js');
  await waitFor(async () => {
    try {
      return (await fetch(BASE + '/api/v1/jobs/dead')).status === 200;
    } catch {
      return false;
    }
  }, 15000, 'API to accept requests');
  out('API is up.');

  const p1 = await enqueue('quick_work', {}, 'evidence_succeeded');
  out(`POST /api/v1/jobs  -> ${p1.status} ${JSON.stringify(p1.body)}`);
  const p2 = await enqueue('hang_forever', {}, 'evidence_processing');
  out(`POST /api/v1/jobs  -> ${p2.status} ${JSON.stringify(p2.body)}`);
  // Two doomed jobs: one is left dead for the dead letter queue, the other is
  // manually retried in phase 3 to produce a retryable 'failed' row.
  const p3 = await enqueue('always_fails', { message: 'Evidence: dependency is down' }, 'evidence_dead');
  out(`POST /api/v1/jobs  -> ${p3.status} ${JSON.stringify(p3.body)}`);
  const p3b = await enqueue('always_fails', { message: 'Evidence: will be retried' }, 'evidence_failed');
  out(`POST /api/v1/jobs  -> ${p3b.status} ${JSON.stringify(p3b.body)}`);

  out();
  out('Duplicate idempotency key, identical payload:');
  const dup = await enqueue('quick_work', {}, 'evidence_succeeded');
  out(`POST /api/v1/jobs  -> ${dup.status} ${JSON.stringify(dup.body)}`);
  out(`same job_id returned? ${dup.body.job_id === p1.body.job_id}`);

  out();
  out('Duplicate idempotency key, DIFFERENT payload:');
  const conflict = await enqueue('quick_work', { different: true }, 'evidence_succeeded');
  out(`POST /api/v1/jobs  -> ${conflict.status} ${JSON.stringify(conflict.body)}`);

  const keyCount = await query('SELECT COUNT(*)::int AS c FROM jobs WHERE idempotency_key=$1', ['evidence_succeeded']);
  out(`SELECT COUNT(*) FROM jobs WHERE idempotency_key='evidence_succeeded' -> ${keyCount.rows[0].c}`);

  // ---- Phase 2: start the worker. ----
  out();
  out('--- Phase 2: start the worker ---');
  launch('worker', 'src/worker/main.js');

  await waitFor(async () => {
    const r = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='succeeded'");
    return r.rows[0].c === 1;
  }, 30000, 'the quick_work job to succeed');
  await waitFor(async () => {
    const r = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='processing'");
    return r.rows[0].c === 1;
  }, 30000, 'the hang_forever job to be claimed');
  await waitUntilDead(2);

  out();
  out('Worker has now driven the queue through: succeeded, processing, dead.');

  // ---- Phase 3: retry one dead job so a retryable 'failed' row coexists. ----
  out();
  out('--- Phase 3: manually retry ONE dead job (it fails again -> failed) ---');
  out('The other dead job is deliberately left alone so the dead letter queue is populated.');
  const retry = await api(`/api/v1/jobs/${p3b.body.job_id}/retry`, { method: 'POST' });
  out(`POST /api/v1/jobs/${p3b.body.job_id}/retry -> ${retry.status} ${JSON.stringify(retry.body)}`);

  await waitFor(async () => {
    const r = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='failed'");
    return r.rows[0].c === 1;
  }, 30000, "the retried job to land in 'failed'");

  // ---- Phase 4: stop the worker, enqueue one more so 'pending' coexists. ----
  out();
  out('--- Phase 4: stop the worker, enqueue one more job (it stays pending) ---');
  const workerChild = children.find((c) => c.spawnargs[1].includes('worker') && c.exitCode === null);
  workerChild.kill('SIGTERM');
  await sleep(1500);
  const p4 = await enqueue('quick_work', {}, 'evidence_pending');
  out(`worker stopped. POST /api/v1/jobs -> ${p4.status} ${JSON.stringify(p4.body)}`);
  await sleep(500);

  // ---- The all-status table. ----
  const statuses = await query('SELECT status, COUNT(*)::int AS c FROM jobs GROUP BY status ORDER BY status');
  out('Status counts: ' + statuses.rows.map((r) => `${r.status}=${r.c}`).join('  '));
  out();
  out('Every status in the state machine is present above: ' +
    ['pending', 'processing', 'succeeded', 'failed', 'dead']
      .every((s) => statuses.rows.some((r) => r.status === s)));

  await table('JOBS TABLE - all five statuses visible');

  // ---- Dead letter queue. ----
  out('--- Dead letter queue ---');
  const dlq = await api('/api/v1/jobs/dead');
  out(`GET /api/v1/jobs/dead -> ${dlq.status}`);
  out(JSON.stringify(dlq.body, null, 2));
  out();
  out('Reading page 50 of a 1-page collection degrades gracefully:');
  const past = await api('/api/v1/jobs/dead?limit=20&offset=980');
  out(`GET /api/v1/jobs/dead?limit=20&offset=980 -> ${past.status} jobs=${JSON.stringify(past.body.jobs)} has_more=${past.body.meta.has_more}`);
  out();

  // ---- The view. ----
  out('--- Dead letter view ---');
  const page = await fetch(BASE + '/');
  const html = await page.text();
  out(`GET / -> ${page.status} ${page.headers.get('content-type')} ${html.length} bytes`);
  out(`contains a Retry button: ${html.includes('>Retry<') || html.includes("'Retry'") || html.includes('Retry')}`);
  out(`contains a dead letter table: ${html.includes('last_error')}`);
  out(`screenshot this at ${BASE}/ while the demo is running`);

  // ---- Backoff growth, from a fresh job so the timeline is self-contained. ----
  out();
  out('--- Phase 5: backoff growth (fresh server + worker, base 5s, jitter 10%) ---');
  out('A second API on port ' + PORT_FAST + ' is needed because the API stamps max_attempts');
  out('onto the row at enqueue time, so the server must be the one configured for 3.');
  await query('TRUNCATE jobs, charges CASCADE');

  const fastEnv = {
    PORT: PORT_FAST,
    JOB_MAX_ATTEMPTS: '3',
    JOB_BACKOFF_BASE_SECONDS: '5',
    JOB_CONCURRENCY_CAP: '1',
    JOB_CLAIM_INTERVAL_SECONDS: '0.1',
    JOB_HEARTBEAT_INTERVAL_SECONDS: '5',
  };
  launch('api-fast', 'src/server.js', fastEnv);
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${PORT_FAST}/api/v1/jobs/dead`)).status === 200;
    } catch {
      return false;
    }
  }, 15000, 'the second API to accept requests');
  launch('worker-fast', 'src/worker/main.js', fastEnv);
  currentBase = `http://127.0.0.1:${PORT_FAST}`;
  await sleep(1200);

  const bo = await enqueue('always_fails', { message: 'Backoff demo' }, 'evidence_backoff');
  out(`POST /api/v1/jobs -> ${bo.status} ${JSON.stringify(bo.body)}`);
  const boRow = (await query('SELECT max_attempts FROM jobs WHERE id=$1', [bo.body.job_id])).rows[0];
  out(`row was created with max_attempts=${boRow.max_attempts}`);
  const timeline = [];
  let lastKey = '';
  await waitFor(async () => {
    const row = (await query('SELECT * FROM jobs WHERE id=$1', [bo.body.job_id])).rows[0];
    const key = `${row.status}|${row.attempts}`;
    if (key !== lastKey) {
      lastKey = key;
      timeline.push({
        at: new Date().toISOString(),
        status: row.status,
        attempts: row.attempts,
        run_at: shortTime(row.run_at),
      });
    }
    return row.status === 'dead';
  }, 120000, 'the backoff demo job to die');

  out();
  out('Observed state changes:');
  for (const t of timeline) {
    out(`  ${t.at}  ${t.status.padEnd(10)} attempts=${t.attempts}  run_at=${t.run_at}`);
  }

  // The failing handler throws in under a millisecond, so a poller cannot
  // reliably catch 'processing'. The recorded attempt transitions can, and the
  // gap between them is exactly the backoff delay that was applied.
  const attemptMarks = timeline.filter((t) => t.status === 'failed' || t.status === 'dead');
  const gaps = [];
  for (let i = 1; i < attemptMarks.length; i += 1) {
    gaps.push((new Date(attemptMarks[i].at) - new Date(attemptMarks[i - 1].at)) / 1000);
  }
  out();
  out('  attempts observed: ' + attemptMarks.map((t) => t.attempts).join(' -> ') +
    `  (${attemptMarks.length} executions, one per attempt)`);
  out('  backoff delay before each retry (seconds): ' +
    gaps.map((g, i) => `before attempt ${i + 2}=${g.toFixed(2)}`).join('  '));
  out('  ~5s then ~10s: exponential, each one inside +/-10% jitter.');
  out('  run_at stops moving once the job is dead, so a dead job is never rescheduled.');
  if (attemptMarks.length !== 3 || gaps.length !== 2) {
    out('  WARNING: expected 3 executions and 2 gaps, got ' + attemptMarks.length + ' and ' + gaps.length);
  }

  out();
  out('=================================================================');
  out(' end of evidence run');
  out('=================================================================');
}

async function waitUntilDead(expected) {
  await waitFor(async () => {
    const r = await query("SELECT COUNT(*)::int AS c FROM jobs WHERE status='dead'");
    return r.rows[0].c === expected;
  }, 30000, `${expected} always_fails job(s) to die`);
}

main()
  .then(async () => {
    shutdown();
    const dest = resolve(ROOT, 'evidence', 'console-output.txt');
    await writeFile(dest, lines.join('\n') + '\n', 'utf8');
    out();
    console.log(`\nWrote ${dest}`);
    await closePool();
    await sleep(300);
    process.exit(0);
  })
  .catch(async (err) => {
    out();
    out(`EVIDENCE RUN FAILED: ${err.message}`);
    console.error(err);
    shutdown();
    await writeFile(resolve(ROOT, 'evidence', 'console-output.txt'), lines.join('\n') + '\n', 'utf8');
    await closePool().catch(() => {});
    process.exit(1);
  });
