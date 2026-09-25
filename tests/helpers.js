import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../src/db/index.js';
import { loadConfig } from '../src/config/index.js';
import { buildApp } from '../src/api/app.js';
import { createWorker } from '../src/worker/worker.js';
import { buildProviders, createHandlers } from '../src/worker/handlers.js';
import { createLogger } from '../src/worker/logger.js';

export const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

let dataDir;

export async function freshDataDir() {
  dataDir = await mkdtemp(join(tmpdir(), 'bg-jobs-test-'));
  return dataDir;
}

export function currentDataDir() {
  return dataDir;
}

export function testConfig(overrides = {}) {
  return loadConfig({ ...process.env, ...overrides });
}

export async function resetDb() {
  await query('TRUNCATE jobs, charges CASCADE');
}

// ---------------------------------------------------------------------------
// Resource registry.
//
// A worker that outlives its test is the single most destructive thing that can
// happen to this suite: it keeps claiming rows across the TRUNCATE in the next
// test's beforeEach, which silently corrupts that test's assertions and keeps
// the process alive after the run. Everything created here is tracked and torn
// down before each test, so a failing test cannot leak into the next one.
// ---------------------------------------------------------------------------
const registry = { workers: [], servers: [] };

export function trackWorker(worker) {
  registry.workers.push(worker);
  return worker;
}

export function trackServer(server) {
  registry.servers.push(server);
  return server;
}

export async function teardownAll() {
  const workers = registry.workers.splice(0);
  const servers = registry.servers.splice(0);

  await Promise.all(
    workers.map(async (w) => {
      try {
        await w.stop();
      } catch {
        // a worker that refuses to stop must not block the next test
      }
    })
  );

  await Promise.all(
    servers.map((s) => s.close().catch(() => {}))
  );
}

export async function closeDb() {
  await teardownAll();
  await closePool();
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function startTestServer(config) {
  const app = buildApp({ db: { query }, config });
  const server = await new Promise((resolvePromise) => {
    const s = app.listen(0, () => resolvePromise(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return trackServer({
    baseUrl,
    async close() {
      await new Promise((resolvePromise) => server.close(resolvePromise));
    },
  });
}

export async function api(baseUrl, method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, retryAfter: res.headers.get('retry-after') };
}

export const enqueue = (baseUrl, type, payload, idempotency_key) =>
  api(baseUrl, 'POST', '/api/v1/jobs', { type, payload, idempotency_key });

export const getJob = (baseUrl, id) => api(baseUrl, 'GET', `/api/v1/jobs/${id}`);

export const listDead = (baseUrl, queryString = '') =>
  api(baseUrl, 'GET', `/api/v1/jobs/dead${queryString}`);

export const retryDead = (baseUrl, id) => api(baseUrl, 'POST', `/api/v1/jobs/${id}/retry`);

export const getPage = (baseUrl) => api(baseUrl, 'GET', '/');

export function makeHandlers(overrides = {}) {
  const handlers = createHandlers({
    db: { query },
    providers: buildProviders(currentDataDir()),
  });
  return Object.assign(handlers, overrides);
}

export function makeWorker({ config, handlers, workerId, hooks, collectLogs = false }) {
  const logLines = [];
  const logger = createLogger(workerId, collectLogs ? { sink: () => {} } : {});
  if (collectLogs) {
    const capture = (level) => {
      const original = logger[level].bind(logger);
      logger[level] = (...args) => {
        const line = original(...args);
        logLines.push(line);
        return line;
      };
    };
    capture('info');
    capture('warn');
    capture('error');
  }

  const worker = trackWorker(
    createWorker({
      config,
      db: { query },
      handlers,
      workerId,
      hooks,
      logger,
    })
  );

  return { worker, logLines };
}

export const EVIDENCE_DIR = resolve(process.cwd(), 'evidence');

export async function writeEvidence(relativePath, content) {
  const file = join(EVIDENCE_DIR, relativePath);
  await mkdir(dirnameOf(relativePath), { recursive: true });
  await writeFile(file, content, 'utf8');
}

function dirnameOf(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  parts.pop();
  return join(EVIDENCE_DIR, ...parts);
}

export async function pollUntil(predicate, timeoutMs = 60000, intervalMs = 200, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label} (last value: ${JSON.stringify(last)})`);
}

export const guid = () => randomUUID().replace(/-/g, '');

/** Renders rows as a fixed-width table for evidence output. */
export function renderTable(rows, columns) {
  if (rows.length === 0) return '(no rows)';
  const head = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => {
    const v = typeof c.get === 'function' ? c.get(r) : r[c.key];
    return v === null || v === undefined ? '-' : String(v);
  }));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(head), widths.map((w) => '-'.repeat(w)).join('  '), ...body.map(line)].join('\n');
}

export function consoleBlock(title, lines) {
  console.log(`\n===== ${title} =====`);
  for (const l of lines) console.log(l);
  console.log(`===== end ${title} =====\n`);
}
