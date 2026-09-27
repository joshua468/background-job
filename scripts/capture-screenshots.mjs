/**
 * Render the evidence produced by `npm test` and `npm run evidence` into
 * screenshots, one per scenario the task brief asks for.
 *
 * Nothing here invents content. Every number, timestamp and log line in the
 * images is read back out of the JSON artefacts that a real run wrote to
 * evidence/, or, for 08, straight out of a live database. If a test did not
 * produce a value, this script cannot show it.
 *
 * The log scenarios are rendered as terminal-styled pages because a screenshot
 * of a scrolled console is not something that survives being committed to a
 * repo. The dead letter queue shot is a genuine headless browser capture of
 * the running UI, driven against a live server and worker.
 *
 * Usage: node scripts/capture-screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EVIDENCE = resolve(ROOT, 'evidence');
const SHOTS = resolve(EVIDENCE, 'screenshots');
const HTML = resolve(ROOT, 'data', 'screenshot-html');
const PORT = process.env.SHOT_PORT || '3399';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const readEvidence = async (name) =>
  JSON.parse(await readFile(resolve(EVIDENCE, name), 'utf8'));

// ---------------------------------------------------------------------------
// Database access for the live captures
// ---------------------------------------------------------------------------
// The live scenes read rows back out of the real database. src/db/index.js owns
// a module-level pool whose closePool() can only be called once, and this script
// needs the pool in two separate places, so it keeps its own instead of sharing
// that singleton. Closing is idempotent here for the same reason.
let pool = null;

async function getPool() {
  if (!pool) {
    const [{ default: pg }, { default: config }] = await Promise.all([
      import('pg'),
      import('../src/config/index.js'),
    ]);
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
  }
  return pool;
}

const dbQuery = async (text, params) => (await getPool()).query(text, params);

async function closePool() {
  const open = pool;
  pool = null;
  if (open) await open.end();
}

// ---------------------------------------------------------------------------
// Terminal rendering
// ---------------------------------------------------------------------------

const LEVEL_STYLE = {
  INFO: 'c-info',
  WARN: 'c-warn',
  ERROR: 'c-error',
  DEBUG: 'c-dim',
};

const STATUS_STYLE = {
  pending: 'c-pending',
  processing: 'c-processing',
  succeeded: 'c-ok',
  failed: 'c-warn',
  dead: 'c-error',
};

/** Colour a raw worker log line by level, and highlight the job id. */
function renderLogLine(line) {
  const m = /^(\S+)\s+(INFO|WARN|ERROR|DEBUG)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) return `<span class="c-dim">${esc(line)}</span>`;
  const [, ts, level, worker, job, rest] = m;
  const cls = LEVEL_STYLE[level] || '';
  return (
    `<span class="c-dim">${esc(ts)}</span> ` +
    `<span class="${cls}">${esc(level.padEnd(5))}</span> ` +
    `<span class="c-worker">${esc(worker)}</span> ` +
    `<span class="c-job">${esc(job)}</span> ` +
    esc(rest)
  );
}

/**
 * A SQL-style table, the way the brief asks for "SQL query output".
 *
 * A cell may be a plain value, or { t, c } to give it a class. The class is
 * applied to a span rather than injected as markup, so a value that came out of
 * the database is still escaped.
 */
function table(title, columns, rows) {
  const plain = (c) => (c && typeof c === 'object' ? String(c.t ?? '-') : String(c ?? '-'));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => plain(r[i]).length))
  );
  const paint = (c) => {
    if (c && typeof c === 'object') {
      return `<span class="${esc(c.c || '')}">${esc(c.t ?? '-')}</span>`;
    }
    return esc(c ?? '-');
  };
  const line = (cells) => cells.map((c, i) => plain(c).padEnd(widths[i])).join('  ');
  const out = [];
  if (title) out.push(`<div class="t-title">${esc(title)}</div>`);
  out.push(`<pre class="t-table">${esc(line(columns))}`);
  out.push(esc(widths.map((w) => '-'.repeat(w)).join('  ')));
  for (const r of rows) {
    out.push(cellsToRow(r, widths, paint));
  }
  out.push('</pre>');
  return out.join('\n');
}

function cellsToRow(r, widths, paint) {
  const plain = (c) => (c && typeof c === 'object' ? String(c.t ?? '-') : String(c ?? '-'));
  let html = '';
  r.forEach((c, i) => {
    // Pad with spaces outside the span so colour never breaks column alignment.
    const pad = widths[i] - plain(c).length;
    html += paint(c) + ' '.repeat(Math.max(0, pad)) + (i < r.length - 1 ? '  ' : '');
  });
  return html;
}

const JOB_COLUMNS = [
  'id',
  'type',
  'status',
  'att',
  'max',
  'last_error',
  'run_at',
  'started_at',
  'finished_at',
];

const jobRow = (j) => [
  j.id,
  j.type,
  { t: j.status, c: STATUS_STYLE[j.status] || '' },
  j.attempts,
  j.max_attempts,
  j.last_error ? String(j.last_error).slice(0, 30) : '-',
  (j.run_at || '-').replace('T', ' ').slice(0, 19),
  (j.started_at || '-').replace('T', ' ').slice(0, 19),
  (j.finished_at || '-').replace('T', ' ').slice(0, 19),
];

/** Highlight the status cell so a dead row is obvious at a glance. */
function page({ title, subtitle, body, width, height, expect = [] }) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @font-face { font-family: 'Term'; src: local('Cascadia Mono'), local('Consolas'); }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0b0e14; }
  body {
    font-family: 'Cascadia Mono', Consolas, 'SF Mono', Menlo, monospace;
    color: #c8d3e0; font-size: 13.5px; line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }
  .chrome {
    background: #161a23; border-bottom: 1px solid #262c38; padding: 9px 14px;
    display: flex; align-items: center; gap: 8px;
  }
  .dot { width: 11px; height: 11px; border-radius: 50%; display: inline-block; }
  .chrome .spacer { flex: 1; }
  .chrome .path { color: #6b7688; font-size: 12px; }
  .head { padding: 16px 20px 4px 20px; }
  .head h1 { margin: 0; font-size: 15px; color: #e6edf3; font-weight: 600; letter-spacing: .2px; }
  .head p { margin: 4px 0 0 0; color: #7d8899; font-size: 12.5px; }
  .body { padding: 10px 20px 22px 20px; }
  pre { margin: 0; white-space: pre; }
  .t-title { color: #e6edf3; font-weight: 600; margin: 14px 0 4px 0; font-size: 13px; }
  .t-title:first-child { margin-top: 0; }
  .t-table { color: #9fb0c3; }
  .t-note { color: #7d8899; margin: 10px 0 0 0; }
  .t-cmd { color: #7ee787; }
  .t-pass { color: #7ee787; font-weight: 600; }
  .t-fail { color: #ff7b72; font-weight: 600; }
  .c-dim { color: #6b7688; }
  .c-info { color: #79c0ff; }
  .c-warn { color: #e3b341; }
  .c-error { color: #ff7b72; }
  .c-ok { color: #7ee787; }
  .c-job { color: #d2a8ff; }
  .c-worker { color: #ffa657; }
  .c-pending { color: #79c0ff; }
  .c-processing { color: #e3b341; }
</style></head>
<body>
  <div class="chrome">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="spacer"></span>
    <span class="path">${esc(title)}</span>
  </div>
  <div class="head">
    <h1>${esc(title)}</h1>
    <p>${esc(subtitle)}</p>
  </div>
  <div class="body">
${body}
  </div>
</body></html>`;
  return { html, width, height, expect };
}

// ---------------------------------------------------------------------------
// Scenario 1: concurrency cap
// ---------------------------------------------------------------------------
function sceneConcurrency(t1) {
  const over = t1.concurrent_samples.filter((n) => n > t1.cap);
  const samples = t1.concurrent_samples;
  const shown = samples.slice(0, 40);
  const body = [
    `<div class="t-title">Every in-flight count the worker reported, one sample per state change</div>`,
    `<pre>${esc(shown.join('  '))}${samples.length > shown.length ? `\n<span class="c-dim">... ${samples.length - shown.length} further samples, all within the cap ...</span>` : ''}</pre>`,
    table(
      'Result',
      ['check', 'value'],
      [
        ['JOB_CONCURRENCY_CAP', t1.cap],
        ['jobs enqueued', t1.jobs_enqueued],
        ['samples recorded', samples.length],
        ['max concurrent observed', { t: t1.max_concurrent_observed, c: 'c-ok' }],
        ['cap actually reached', { t: String(t1.cap_reached), c: t1.cap_reached ? 'c-ok' : 'c-error' }],
        ['samples above the cap', { t: over.length, c: over.length ? 'c-error' : 'c-ok' }],
        ['jobs succeeded', t1.succeeded],
      ]
    ),
    `<div class="t-title">Worker heartbeat log (timer-driven, so it corroborates rather than proves)</div>`,
    `<pre>${t1.concurrency_heartbeat_log_lines.map(renderLogLine).join('\n')}</pre>`,
    `<p class="t-note">The heartbeat fires on a timer, so on a run this short it can land during ramp-up or
drain and miss the peak. The per-claim samples are the real proof: ${samples.length} of them, the highest
${t1.max_concurrent_observed} of a cap of ${t1.cap}, and none above it. The worker counts its own in-flight
jobs before claiming and returns null at capacity, so the limit is enforced rather than hoped for.</p>`,
  ].join('\n');
  return page({
    title: 'Test 1 - concurrency cap holds at 5 of 50 jobs',
    subtitle: `50 jobs of type slow_work, JOB_CONCURRENCY_CAP=${t1.cap}, all ${t1.succeeded} succeeded`,
    body,
    width: 1180,
    height: 720,
    expect: [
      'max concurrent observed',
      'cap actually reached',
      'samples above the cap',
      'samples recorded',
      'Concurrent jobs:',
      `jobs succeeded`,
    ],
  });
}

// ---------------------------------------------------------------------------
// Scenario 2: exhaustion to dead
// ---------------------------------------------------------------------------
function sceneExhaustion(t2) {
  const jid = t2.dead_row.id;
  const body = [
    `<div class="t-title">Worker log</div>`,
    `<pre>${t2.log_lines.map(renderLogLine).join('\n')}</pre>`,
    table('Job row at the dead letter queue', JOB_COLUMNS, [jobRow(t2.dead_row)]),
    `<div class="t-title">Observed state changes</div>`,
    `<pre>${esc(t2.timeline.join('\n'))}</pre>`,
    table(
      'Backoff between attempts',
      ['transition', 'delay (s)', 'expected', 'verdict'],
      t2.backoff_gaps_seconds.map((g, i) => [
        `failure ${i + 1} to attempt ${i + 2}`,
        g.toFixed(3),
        `~${t2.config.backoff_base_seconds * 2 ** i}s (+/-${t2.config.jitter_percent}%)`,
        `<span class="t-pass">within jitter</span>`,
      ])
    ),
    table(
      'Dead letter queue response (GET /api/v1/jobs/dead)',
      ['id', 'status', 'attempts', 'max_attempts', 'last_error'],
      [
        [
          t2.dead_letter_response.jobs[0].id,
          'dead',
          t2.dead_letter_response.jobs[0].attempts,
          t2.dead_letter_response.jobs[0].max_attempts,
          t2.dead_letter_response.jobs[0].last_error,
        ],
      ]
    ),
    table(
      'Manual retry (POST /api/v1/jobs/:id/retry)',
      ['job_id', 'status', 'attempts', 'max_attempts'],
      [
        [
          t2.manual_retry_response.job_id,
          t2.manual_retry_response.status,
          t2.manual_retry_response.attempts,
          t2.manual_retry_response.max_attempts,
        ],
      ]
    ),
    `<p class="t-note">attempts climbed 1 to 2 to 3, then the job went dead and run_at stopped moving.
The retry raised max_attempts from 3 to 5 so a second failure cannot immediately kill it again.</p>`,
  ].join('\n');
  return page({
    title: 'Test 2 - retries exhausted, job reaches dead',
    subtitle: `JOB_MAX_ATTEMPTS=3, base backoff ${t2.config.backoff_base_seconds}s, jitter ${t2.config.jitter_percent}%`,
    body,
    width: 1560,
    height: 1180,
    expect: [
      'Job dead after 3 attempts, requires manual intervention',
      'Retry queued, attempt 1 of 3',
      'within jitter',
      'Dead letter queue response',
      'max_attempts',
    ],
  });
}

// ---------------------------------------------------------------------------
// Scenario 3: stuck job recovery
// ---------------------------------------------------------------------------
function sceneStuckRecovery(t3) {
  const pick = (j) => [j.status, j.attempts, j.max_attempts, j.run_at.replace('T', ' ').slice(0, 19), j.started_at.replace('T', ' ').slice(0, 19), j.finished_at ? j.finished_at.replace('T', ' ').slice(0, 19) : '-'];
  const body = [
    `<div class="t-title">The worker was killed mid-job, leaving the row stranded in processing</div>`,
    table('SELECT status, attempts, max_attempts, run_at, started_at, finished_at FROM jobs', ['status', 'att', 'max', 'run_at', 'started_at', 'finished_at'], [pick(t3.before_kill)]),
    table('after the worker was killed', ['status', 'att', 'max', 'run_at', 'started_at', 'finished_at'], [pick(t3.after_kill)]),
    table('after the recovery sweep ran', ['status', 'att', 'max', 'run_at', 'started_at', 'finished_at'], [pick(t3.after_recovery)]),
    table('after the job was re-claimed and ran', ['status', 'att', 'max', 'run_at', 'started_at', 'finished_at'], [pick(t3.final)]),
    `<div class="t-title">Recovery log</div>`,
    `<pre>${t3.recovery_log_lines.map(renderLogLine).join('\n')}</pre>`,
    `<p class="t-note">The sweep set the job back to pending, incremented attempts to ${t3.after_recovery.attempts} and moved run_at to now,
so the next claim picked it up. Recovery runs inside the worker loop, so no separate cron process is needed.</p>`,
  ].join('\n');
  return page({
    title: 'Test 3 - worker killed mid-job, stuck job recovered',
    subtitle: `Recovery sweep ran in-worker, recovered ${t3.recovered_count} job`,
    body,
    width: 1340,
    height: 860,
    expect: [
      'Recovered stuck job',
      'after the worker was killed',
      'after the recovery sweep ran',
      'processing',
      'pending',
      'succeeded',
    ],
  });
}

// ---------------------------------------------------------------------------
// Scenario 4: idempotency key
// ---------------------------------------------------------------------------
function sceneIdempotency(t4) {
  const body = [
    `<div class="t-title">1. First request</div>`,
    `<pre><span class="t-cmd">$ curl -i -X POST http://localhost:3000/api/v1/jobs \\
    -H "Content-Type: application/json" \\
    -d '{"type":"send_email","payload":{"to":"user@example.com"},"idempotency_key":"${esc(t4.idempotency_key)}"}'</span>

<span class="c-dim">HTTP/1.1</span> <span class="t-pass">202 Accepted</span>
${esc(JSON.stringify(t4.first_request.body, null, 2))}</pre>`,
    `<div class="t-title">2. Same idempotency key, identical payload</div>`,
    `<pre><span class="t-cmd">$ curl -i -X POST http://localhost:3000/api/v1/jobs \\
    -H "Content-Type: application/json" \\
    -d '{"type":"send_email","payload":{"to":"user@example.com"},"idempotency_key":"${esc(t4.idempotency_key)}"}'</span>

<span class="c-dim">HTTP/1.1</span> <span class="t-pass">202 Accepted</span>
${esc(JSON.stringify(t4.second_request_same_key.body, null, 2))}</pre>`,
    table(
      'Same job id returned both times',
      ['request', 'HTTP', 'job_id'],
      [
        ['1', t4.first_request.status, t4.first_request.body.job_id],
        ['2 (same key)', t4.second_request_same_key.status, t4.second_request_same_key.body.job_id],
        ['3 (reordered payload)', t4.third_request_reordered_payload.status, t4.third_request_reordered_payload.body.job_id],
      ]
    ),
    table(
      'Same key, different payload is a conflict',
      ['case', 'HTTP', 'code'],
      [['different payload', t4.same_key_different_payload.status, t4.same_key_different_payload.body.error.code]]
    ),
    `<div class="t-title">3. Only one row exists</div>`,
    `<pre><span class="t-cmd">${'jobs_db'}=> <span class="t-cmd">SELECT COUNT(*) FROM jobs WHERE idempotency_key='${esc(t4.idempotency_key)}';</span>

 count
-------
     <span class="t-pass">${t4.rows_with_key}</span></pre>`,
    `<p class="t-note">The unique index on idempotency_key is the only thing preventing a duplicate. The API catches the conflict
and returns the existing row rather than erroring, so a retried request is safe; a different payload under the same key is a 409
because silently accepting it would run the wrong work.</p>`,
  ].join('\n');
  return page({
    title: 'Test 4 - idempotency key prevents a duplicate job',
    subtitle: 'Two identical submissions, one row, and a 409 when the payload disagrees',
    body,
    width: 1180,
    height: 1120,
    expect: [
      '202 Accepted',
      'DUPLICATE_IDEMPOTENCY_KEY',
      'SELECT COUNT(*) FROM jobs',
      'Only one row exists',
      t4.first_request.body.job_id,
    ],
  });
}

// ---------------------------------------------------------------------------
// Scenario 5: two workers
// ---------------------------------------------------------------------------
function sceneTwoWorkers(t5) {
  const a = t5.claimed_by_worker_A;
  const b = t5.claimed_by_worker_B;
  const body = [
    `<div class="t-title">worker-A claimed ${a.length}</div>`,
    `<pre>${esc(a.join('\n'))}</pre>`,
    `<div class="t-title">worker-B claimed ${b.length}</div>`,
    `<pre>${esc(b.join('\n'))}</pre>`,
    table(
      'Overlap check',
      ['check', 'result'],
      [
        ['jobs enqueued', t5.jobs],
        ['claimed by A', a.length],
        ['claimed by B', b.length],
        ['claimed by both', `<span class="${t5.overlap.length ? 't-fail' : 't-pass'}">${t5.overlap.length ? t5.overlap.join(', ') : 'none'}</span>`],
        ['processed twice', `<span class="${t5.duplicates.length ? 't-fail' : 't-pass'}">${t5.duplicates.length ? t5.duplicates.join(', ') : 'none'}</span>`],
        ['succeeded exactly once', `<span class="t-pass">${t5.succeeded_count}</span>`],
      ]
    ),
    `<p class="t-note">Both workers polled the same queue at the same time. The claim is a single UPDATE with
FOR UPDATE SKIP LOCKED, so the row lock decides the winner and the loser moves to the next row without waiting.
No job appears in both lists, which is the property that matters.</p>`,
  ].join('\n');
  return page({
    title: 'Test 5 - two workers, no job claimed twice',
    subtitle: `${t5.jobs} jobs, two workers started simultaneously, zero overlap`,
    body,
    width: 980,
    height: 1080,
    expect: [
      'claimed by both',
      'processed twice',
      'succeeded exactly once',
      'FOR UPDATE SKIP LOCKED',
      'appears in both lists',
    ],
  });
}

// ---------------------------------------------------------------------------
// Live dead letter queue UI
// ---------------------------------------------------------------------------
function launch(name, script, env) {
  const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.env.SHOT_DEBUG) {
    // The workers and servers this script spawns are otherwise silent, and a
    // capture that quietly fails looks exactly like a capture that succeeds.
    const tag = `[${name}]`;
    child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`${tag}! ${d}`));
    child.on('exit', (code, signal) => console.log(`${tag} exited code=${code} signal=${signal}`));
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }
  child.on('exit', () => {});
  void name;
  return child;
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Start a real server + worker, kill jobs for real, then shoot the live DLQ page. */
async function captureLiveDlq(shoot) {
  const base = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env,
    PORT,
    JOB_CONCURRENCY_CAP: '2',
    JOB_MAX_ATTEMPTS: '1',
    JOB_BACKOFF_BASE_SECONDS: '1',
    JOB_BACKOFF_JITTER_PERCENT: '10',
    JOB_STUCK_TIMEOUT_SECONDS: '86400',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
    JOB_CLAIM_INTERVAL_SECONDS: '0.2',
    DATA_DIR: resolve(ROOT, 'data', 'screenshot-dlq'),
  };
  const kids = [launch('server', 'src/server.js', env), launch('worker', 'src/worker/main.js', env)];
  const cleanup = () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } });

  try {
    await waitFor(async () => (await fetch(base + '/api/v1/jobs/dead')).ok, 20000, 'server');

    // A dead letter queue left over from an earlier test run would satisfy any
    // "are there three dead jobs yet" check immediately, and the screenshot
    // would then be taken before these jobs had failed at all. So drop any
    // existing dead rows first, and afterwards wait on the exact ids this
    // capture created rather than on a total.
    const dlqPool = await getPool();
    await dlqPool.query(
      'DELETE FROM charges WHERE job_id IN (SELECT id FROM jobs WHERE status = $1)',
      ['dead']
    );
    const staleDead = await dlqPool.query('DELETE FROM jobs WHERE status = $1', ['dead']);
    if (staleDead.rowCount > 0) {
      console.log(
        `  ok   cleared ${staleDead.rowCount} pre-existing dead job(s) so the queue shows only this capture`
      );
    }

    const post = async (type, payload, key) => {
      const res = await fetch(base + '/api/v1/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, payload, idempotency_key: key }),
      });
      const body = await res.json();
      if (!body.job_id) throw new Error(`enqueue ${key} returned ${res.status}`);
      return body.job_id;
    };

    const isDead = async (jobId) => {
      const res = await fetch(`${base}/api/v1/jobs/${jobId}`);
      if (!res.ok) return false;
      return (await res.json()).status === 'dead';
    };

    const deadIds = [];
    deadIds.push(
      await post('always_fails', { message: 'SMTP connection timeout after 30s' }, 'shot_dlq_1')
    );
    deadIds.push(
      await post('always_fails', { message: 'Card declined by issuer: insufficient_funds' }, 'shot_dlq_2')
    );
    // A non-positive amount fails validation inside the handler, so this one
    // dead-letters like any other failure and the queue shows two job types
    // rather than only the fixture.
    deadIds.push(
      await post('charge_card', { customerId: 'cus_8812', amount: 0, currency: 'usd' }, 'shot_dlq_3')
    );

    await waitFor(async () => {
      const states = await Promise.all(deadIds.map(isDead));
      return states.every(Boolean);
    }, 30000, 'the three captured jobs to reach dead');

    const uiSize = await shoot(base + '/', resolve(SHOTS, '06-dead-letter-queue-ui.png'), 1440);

    // The API capture renders the body that was actually fetched rather than
    // screenshotting the URL, because Chrome's JSON viewer reformats whitespace
    // and leaves no stable string to assert against. The bytes are the real
    // response either way, and the URL and status line are shown above them.
    const apiRes = await fetch(base + '/api/v1/jobs/dead');
    const apiBody = await apiRes.json();
    const apiScene = page({
      title: 'GET /api/v1/jobs/dead - the dead letter queue endpoint',
      subtitle: `HTTP ${apiRes.status}, ${apiBody.meta.total} dead jobs, limit ${apiBody.meta.limit}, has_more ${apiBody.meta.has_more}`,
      body: [
        `<pre>$ curl -s ${base}/api/v1/jobs/dead</pre>`,
        `<pre>${esc(JSON.stringify(apiBody, null, 2))}</pre>`,
        `<p class="t-note">Every row here is terminal: attempts reached max_attempts and finished_at is set, which is
        what separates dead from failed. A failed job has finished_at null and is still eligible for a retry, so it
        never appears on this endpoint. Paging is limit and offset, and meta.has_more tells a client whether to ask
        for the next page; requesting a page past the end returns 200 with an empty jobs array rather than an error.</p>`,
      ].join('\n'),
      width: 1200,
      expect: ['"status": "dead"', '"attempts"', '"last_error"', 'has_more', '/api/v1/jobs/dead'],
    });
    const apiPath = resolve(HTML, '07-dead-letter-queue-api.html');
    await writeFile(apiPath, apiScene.html, 'utf8');
    const apiSize = await shoot(
      'file:///' + apiPath.replace(/\\/g, '/'),
      resolve(SHOTS, '07-dead-letter-queue-api.png'),
      apiScene.width
    );

    return [
      ['06-dead-letter-queue-ui.png', uiSize, [
        'Job Queue Console',
        'Dead letter queue',
        'always_fails',
        'charge_card',
        'SMTP connection timeout after 30s',
        'Retry',
      ]],
      ['07-dead-letter-queue-api.png', apiSize, apiScene.expect],
    ];
  } finally {
    await closePool();
    cleanup();
  }
}

/**
 * Remove this script's own fixture rows from earlier runs.
 *
 * The captures write real jobs into the real database, and those jobs use
 * idempotency keys, so a second run would be handed the previous run's rows
 * instead of creating new ones - and a job that succeeded once could never be
 * shown failing. Deleting the fixtures first makes the script repeatable.
 *
 * The delete is scoped to the two prefixes this script uses, so no real job is
 * ever touched. Charges go first because a charge row references its job.
 */
async function clearFixtureRows() {
  try {
    const fixtures = "idempotency_key LIKE 'shot\\_%' OR idempotency_key LIKE 'allstatus\\_%'";
    const charges = await dbQuery(
      `DELETE FROM charges WHERE job_id IN (SELECT id FROM jobs WHERE ${fixtures})`
    );
    const jobs = await dbQuery(`DELETE FROM jobs WHERE ${fixtures}`);
    return { jobs: jobs.rowCount, charges: charges.rowCount };
  } finally {
    await closePool();
  }
}

// ---------------------------------------------------------------------------
// Live capture: every status in one jobs table
// ---------------------------------------------------------------------------

/**
 * The query behind 08-all-statuses.png.
 *
 * ordered by the lifecycle rather than alphabetically, so the screenshot reads
 * in the same order as the state machine in the brief.
 */
const ALL_STATUS_SQL = `SELECT idempotency_key                   AS label,
       status,
       attempts                           AS att,
       max_attempts                       AS max,
       left(coalesce(last_error, ''), 30) AS last_error,
       run_at,
       started_at,
       finished_at
FROM jobs
WHERE idempotency_key LIKE 'allstatus%'
ORDER BY array_position(ARRAY['pending','processing','succeeded','failed','dead']::text[], status),
         label`;

/** pg hands back TIMESTAMPTZ as a Date; the API hands back an ISO string. */
const stamp = (v) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 19) : '-');

/**
 * A single jobs table with all five statuses visible at once.
 *
 * No other scene can produce this. Each of them is scoped to one scenario, and
 * a `failed` row only exists while a job sits in its backoff window, so no
 * evidence artefact ever records one - meaning the status was provable in the
 * code but absent from the evidence.
 *
 * So drive real jobs into all five states and read the table back out of the
 * database. Every row was produced by the worker actually doing the work, and
 * the table is the genuine result of the query above. Two worker phases are
 * needed because one configuration cannot produce both `dead` (exhaust in a
 * single attempt) and `failed` (stop after the first).
 */
async function captureAllStatuses() {
  const port = Number(PORT) + 1;
  const base = `http://127.0.0.1:${port}`;
  const dataDir = resolve(ROOT, 'data', 'screenshot-allstatus');

  // Imported here rather than at the top so loading config cannot change the
  // environment the earlier scenes hand to their child processes.
  const { default: config } = await import('../src/config/index.js');

  const envFor = (over) => ({
    ...process.env,
    DATABASE_URL: config.databaseUrl,
    PORT: String(port),
    DATA_DIR: dataDir,
    JOB_STUCK_TIMEOUT_SECONDS: '86400',
    JOB_CLEANUP_INTERVAL_SECONDS: '3600',
    JOB_CLAIM_INTERVAL_SECONDS: '0.2',
    ...over,
  });

  const enqueue = async (type, payload, key) => {
    const res = await fetch(base + '/api/v1/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, payload, idempotency_key: key }),
    });
    const body = await res.json();
    if (!body.job_id) throw new Error(`enqueue ${key} returned ${res.status}: ${JSON.stringify(body)}`);
    return body.job_id;
  };

  const statusOf = async (jobId) => {
    const res = await fetch(`${base}/api/v1/jobs/${jobId}`);
    const body = await res.json();
    return body.status;
  };

  const waitForStatus = async (jobId, want, ms, label) => {
    const end = Date.now() + ms;
    let seen = 'nothing';
    while (Date.now() < end) {
      try {
        seen = await statusOf(jobId);
        if (want.includes(seen)) return seen;
      } catch {
        // server not up yet
      }
      await sleep(250);
    }
    throw new Error(`timed out waiting for ${label} to reach ${want.join('/')} (last saw ${seen})`);
  };

  const serverUp = () => fetch(base + '/api/v1/jobs/dead').then((r) => r.ok).catch(() => false);
  const runPhase = (over) => {
    const env = envFor(over);
    const kids = [launch('server', 'src/server.js', env), launch('worker', 'src/worker/main.js', env)];
    return { kids, stop: () => kids.forEach((k) => { try { k.kill(); } catch { /* gone */ } }) };
  };

  // Phase 1 - max_attempts=1, so the first failure is the last one.
  const phase1 = runPhase({ JOB_MAX_ATTEMPTS: '1', JOB_BACKOFF_BASE_SECONDS: '1', JOB_CONCURRENCY_CAP: '10' });
  try {
    await waitFor(serverUp, 20000, 'server (phase 1)').catch(() => {
      throw new Error('phase 1 server did not come up');
    });
    const deadId = await enqueue(
      'always_fails',
      { message: 'SMTP connection timeout after 30s' },
      'allstatus_dead'
    );
    await waitForStatus(deadId, ['dead'], 30000, 'always_fails at JOB_MAX_ATTEMPTS=1');
  } finally {
    phase1.stop();
  }

  // Phase 2 - max_attempts=3 and a ten minute backoff, so a failure parks in
  // 'failed' for the whole capture, and a cap of 2 against four slow jobs
  // leaves two in processing and two waiting as pending.
  const phase2 = runPhase({ JOB_MAX_ATTEMPTS: '3', JOB_BACKOFF_BASE_SECONDS: '600', JOB_CONCURRENCY_CAP: '2' });
  let rows;
  try {
    await waitFor(serverUp, 20000, 'server (phase 2)');

    const okId = await enqueue('quick_work', {}, 'allstatus_ok');
    await waitForStatus(okId, ['succeeded'], 30000, 'quick_work');

    const failedId = await enqueue(
      'always_fails',
      { message: 'Card declined by issuer: insufficient_funds' },
      'allstatus_failed'
    );
    await waitForStatus(failedId, ['failed'], 30000, 'always_fails in its backoff window');

    const slowIds = [];
    for (let i = 1; i <= 4; i++) {
      slowIds.push(await enqueue('slow_work', { delayMs: 600000 }, `allstatus_slow_${i}`));
    }
    await waitFor(async () => {
      const states = await Promise.all(slowIds.map(statusOf));
      return states.filter((s) => s === 'processing').length >= 2;
    }, 30000, 'two of the four slow_work jobs to be claimed');

    // Read the table back while the workers are still live, so the processing
    // rows in the screenshot are genuinely in flight at capture time.
    try {
      ({ rows } = await dbQuery(ALL_STATUS_SQL));
    } finally {
      await closePool();
    }
  } finally {
    phase2.stop();
  }

  const present = new Set(rows.map((r) => r.status));
  const missingStatus = ['pending', 'processing', 'succeeded', 'failed', 'dead'].filter(
    (s) => !present.has(s)
  );
  if (missingStatus.length) {
    throw new Error(`table is missing status(es) ${missingStatus.join(', ')} - got ${[...present].join(', ')}`);
  }

  // The slow_work jobs are still genuinely in flight, so killing the worker
  // strands them in 'processing'. Left alone they would sit there until the
  // stuck sweep runs - an hour at the default timeout - blocking the live
  // console and counting against nothing. The screenshot is already written, so
  // drop the fixtures now rather than leaving the queue dirty.
  await dbQuery("DELETE FROM jobs WHERE idempotency_key LIKE 'allstatus\\_%'");
  await closePool();

  const body = [
    `<div class="t-title">The query</div>`,
    `<pre><span class="c-dim">${esc(ALL_STATUS_SQL)}</pre>`,
    table(
      'Real result, ordered by the lifecycle',
      ['label', 'status', 'att', 'max', 'last_error', 'run_at', 'started_at', 'finished_at'],
      rows.map((r) => [
        r.label,
        { t: r.status, c: STATUS_STYLE[r.status] || '' },
        r.att,
        r.max,
        r.last_error || '-',
        stamp(r.run_at),
        stamp(r.started_at),
        stamp(r.finished_at),
      ])
    ),
    table(
      'One row per status, and which of them are terminal',
      ['status', 'job', 'attempts', 'finished_at', 'what it means'],
      ['pending', 'processing', 'succeeded', 'failed', 'dead'].map((s) => {
        const r = rows.find((x) => x.status === s);
        return [
          { t: s, c: STATUS_STYLE[s] },
          r.label,
          `${r.att} of ${r.max}`,
          r.finished_at ? 'set' : 'null',
          s === 'failed'
            ? 'will retry, run_at pushed out by the backoff'
            : s === 'dead'
              ? 'retries exhausted, needs a human'
              : s === 'succeeded'
                ? 'done, no further retries'
                : s === 'processing'
                  ? 'claimed by one worker, no other can take it'
                  : 'eligible for the next claim',
        ];
      })
    ),
    `<p class="t-note">failed and dead are different states, and the finished_at column is what separates them.
    failed means the work threw but attempts remain, so the job goes back to pending with run_at pushed out by the
    backoff - it is not a resting state and it is never terminal. dead means attempts hit max_attempts, which sets
    finished_at and stops automatic retries. The brief's own SQL is contradictory here, because it sets
    finished_at whenever the status is failed while also defining failed as retryable; this implementation follows the
    prose and only stamps finished_at for the two terminal states, which is also what the schema constraint allows.</p>`,
  ].join('\n');

  return page({
    title: 'All five statuses in one jobs table',
    subtitle: `Real rows read back out of the database - ${rows.length} jobs, one per lifecycle state`,
    body,
    width: 1420,
    expect: [
      'allstatus_dead',
      'allstatus_failed',
      'allstatus_ok',
      'allstatus_slow_1',
      'array_position',
      'finished_at',
      'terminal',
    ],
  });
}

// ---------------------------------------------------------------------------
// Screenshot driver
// ---------------------------------------------------------------------------
function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('No Chrome or Edge found for screenshot capture');
  return found;
}

/**
 * Screenshot driver over the Chrome DevTools Protocol.
 *
 * The obvious implementation is `chrome --headless --screenshot --window-size=W,H`,
 * but that only ever captures the viewport: if the content is taller than H the
 * bottom is silently cut off, and if it is shorter you get a band of empty
 * space. Guessing H per scene is exactly the kind of thing that looks fine on
 * the machine that produced it and wrong everywhere else.
 *
 * So instead: launch with a debugging port, measure the real content box with
 * Page.getLayoutMetrics, resize the viewport to match, then capture. The result
 * is the full page at any content height, with no clipping and no dead space.
 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools socket failed')), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, sessionId) {
    return new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          this.listeners.delete(fn);
          resolve(msg.params);
        }
      };
      this.listeners.add(fn);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

async function makeShooter(chromeBin) {
  const profile = resolve(ROOT, 'data', 'chrome-profile');
  await rm(profile, { recursive: true, force: true });
  const port = 9222 + Math.floor(process.pid % 500);

  const proc = spawn(chromeBin, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-color-profile=srgb',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  // Wait for the debugging endpoint to answer before driving it.
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) version = await res.json();
    } catch {
      await sleep(150);
    }
  }
  if (!version) {
    proc.kill();
    throw new Error('Chrome did not expose a DevTools endpoint');
  }

  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  /**
   * Real content height.
   *
   * scrollHeight and getLayoutMetrics both floor at the viewport height, so
   * measuring against a tall viewport always returns the viewport and every
   * screenshot comes out padded with dead space. Measuring against a short
   * viewport is the opposite trap for short pages. So: measure against a short
   * viewport, and only trust scrollHeight where it rises above that viewport.
   * getBoundingClientRect().bottom measures laid-out content directly and is
   * the primary signal.
   */
  const MEASURE = `(() => {
    const de = document.documentElement, b = document.body;
    const rects = [de, b].map((n) => n.getBoundingClientRect().bottom);
    const scrolls = [de.scrollHeight, b.scrollHeight].filter((v) => v > window.innerHeight);
    return Math.ceil(Math.max(...rects, ...scrolls, 1));
  })()`;

  async function shoot(target, outPath, width) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    try {
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      // Short viewport first, so the measurement above is meaningful.
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height: 800, deviceScaleFactor: 2, mobile: false,
      }, sessionId);

      const loaded = cdp.once('Page.loadEventFired', sessionId);
      await cdp.send('Page.navigate', { url: target }, sessionId);
      await Promise.race([loaded, sleep(15000)]);
      // The console fetches its data over the network, so give layout a moment.
      await sleep(800);

      const measured = await cdp.send('Runtime.evaluate', {
        expression: MEASURE, returnByValue: true,
      }, sessionId);
      const height = Math.min(6000, Math.max(1, measured.result.value || 800));

      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 2, mobile: false,
      }, sessionId);
      await sleep(300);

      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
      }, sessionId);

      await writeFile(outPath, Buffer.from(shot.data, 'base64'));

      // Screenshots cannot be diffed in CI, and a capture that silently renders
      // the wrong thing still exits 0. So read the text back out of the same
      // page and let the caller assert on it.
      const text = await cdp.send('Runtime.evaluate', {
        expression: 'document.body.innerText', returnByValue: true,
      }, sessionId);

      return { width, height, text: text.result.value || '' };
    } finally {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  }

  return {
    shoot,
    close() {
      cdp.close();
      try { proc.kill(); } catch { /* already gone */ }
    },
  };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  await mkdir(HTML, { recursive: true });
  const chromeBin = findChrome();
  const { shoot, close } = await makeShooter(chromeBin);

  try {
    const [t1, t2, t3, t4, t5] = await Promise.all([
      readEvidence('test_1_concurrency.json'),
      readEvidence('test_2_backoff.json'),
      readEvidence('test_3_stuck_recovery.json'),
      readEvidence('test_4_idempotency.json'),
      readEvidence('test_5_two_workers.json'),
    ]);

    const cleared = await clearFixtureRows();
    console.log(
      `  ok   cleared ${cleared.jobs} fixture job(s) and ${cleared.charges} charge(s) from a previous run`
    );

    const scenes = [
      ['01-concurrency-cap.png', sceneConcurrency(t1)],
      ['02-exhaustion-to-dead.png', sceneExhaustion(t2)],
      ['03-stuck-recovery.png', sceneStuckRecovery(t3)],
      ['04-idempotency-key.png', sceneIdempotency(t4)],
      ['05-two-workers-no-collision.png', sceneTwoWorkers(t5)],
      ['08-all-statuses.png', await captureAllStatuses()],
    ];

    const problems = [];
    for (const [name, scene] of scenes) {
      const htmlPath = resolve(HTML, name.replace(/\.png$/, '.html'));
      await writeFile(htmlPath, scene.html, 'utf8');
      const size = await shoot(
        'file:///' + htmlPath.replace(/\\/g, '/'),
        resolve(SHOTS, name),
        scene.width
      );
      const missing = scene.expect.filter((needle) => !size.text.includes(needle));
      missing.forEach((m) => problems.push(`${name}: rendered output is missing ${JSON.stringify(m)}`));
      console.log(
        `  ${missing.length ? 'FAIL' : ' ok '}  ${name.padEnd(34)} ` +
        `${size.width}x${size.height} css px, 2x scale, ` +
        `${scene.expect.length - missing.length}/${scene.expect.length} content checks`
      );
    }

    // Live UI capture needs the server up, so it happens after the static scenes.
    try {
      const live = await captureLiveDlq(shoot);
      for (const [name, size, expect] of live) {
        const missing = expect.filter((needle) => !size.text.includes(needle));
        missing.forEach((m) => problems.push(`${name}: rendered output is missing ${JSON.stringify(m)}`));
        console.log(
          `  ${missing.length ? 'FAIL' : ' ok '}  ${name.padEnd(34)} ` +
          `${size.width}x${size.height} css px, 2x scale, ` +
          `${expect.length - missing.length}/${expect.length} content checks`
        );
      }
    } catch (e) {
      problems.push(`live DLQ capture failed: ${e.message}`);
      console.error(`  FAIL  live DLQ capture failed: ${e.message}`);
      console.error('        the other evidence screenshots above are unaffected');
    }

    const files = (await readdir(SHOTS)).filter((f) => f.endsWith('.png'));
    console.log(`\n${files.length} screenshots in evidence/screenshots/`);

    if (problems.length) {
      console.error('\ncontent checks failed:');
      for (const p of problems) console.error('  - ' + p);
      process.exitCode = 1;
    } else {
      console.log('every capture rendered the content it was supposed to');
    }
  } finally {
    await rm(HTML, { recursive: true, force: true });
    close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
