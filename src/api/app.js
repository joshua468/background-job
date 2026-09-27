import express from 'express';
import { randomUUID } from 'node:crypto';
import { renderPage } from './views.js';

const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize(value[key]);
    }
    return out;
  }
  return value;
};

const canon = (value) => JSON.stringify(normalize(value));

const err = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

function serializeJob(row) {
  return {
    job_id: row.id,
    type: row.type,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_error: row.last_error,
    run_at: row.run_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Dead letter rows carry enough context to diagnose a failure without opening
 * the database: what was asked for, how many attempts it took, the last error,
 * and the full timing story.
 */
function serializeDeadLetter(row) {
  const finishedAt = row.finished_at ? new Date(row.finished_at) : null;
  const createdAt = row.created_at ? new Date(row.created_at) : null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    payload: row.payload,
    idempotency_key: row.idempotency_key,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    last_error: row.last_error,
    created_at: row.created_at,
    started_at: row.started_at,
    run_at: row.run_at,
    finished_at: row.finished_at,
    seconds_to_die: finishedAt && createdAt
      ? Math.round((finishedAt - createdAt) / 1000)
      : null,
  };
}

export function buildApp({ db, config }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // -------------------------------------------------------------------------
  // GET / - minimal view: enqueue, status, dead letter queue with retry
  // -------------------------------------------------------------------------
  app.get('/', (req, res) => {
    res.type('html').send(renderPage());
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/jobs - enqueue. Returns 202 immediately; no work is done here.
  // -------------------------------------------------------------------------
  app.post('/api/v1/jobs', async (req, res) => {
    const { type, payload, idempotency_key } = req.body || {};

    if (typeof type !== 'string' || type.length === 0) {
      return err(res, 400, 'INVALID_REQUEST', 'Missing required field: type');
    }
    if (payload === undefined) {
      return err(res, 400, 'INVALID_REQUEST', 'Missing required field: payload');
    }
    if (typeof idempotency_key !== 'string' || idempotency_key.length === 0) {
      return err(res, 400, 'INVALID_REQUEST', 'Missing required field: idempotency_key');
    }

    try {
      const jobId = `job_${randomUUID().replace(/-/g, '')}`;
      const insert = await db.query(
        `INSERT INTO jobs (id, type, payload, status, max_attempts,
                           idempotency_key, run_at, created_at, updated_at)
         VALUES ($1, $2, $3, 'pending', $4, $5, NOW(), NOW(), NOW())
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [jobId, type, JSON.stringify(payload), config.maxAttempts, idempotency_key]
      );

      if (insert.rows.length > 0) {
        const row = insert.rows[0];
        return res.status(202).json({
          job_id: row.id,
          status: row.status,
          created_at: row.created_at,
        });
      }

      // Idempotency key already exists. Return the existing job if the payload
      // matches, otherwise reject with 409 (same key, different data).
      const existing = await db.query(
        'SELECT * FROM jobs WHERE idempotency_key = $1',
        [idempotency_key]
      );
      const row = existing.rows[0];
      if (row && canon(row.payload) === canon(payload)) {
        return res.status(202).json({
          job_id: row.id,
          status: row.status,
          created_at: row.created_at,
        });
      }
      return err(res, 409, 'DUPLICATE_IDEMPOTENCY_KEY', 'Idempotency key already used with a different payload');
    } catch (error) {
      return err(res, 500, 'DATABASE_ERROR', error.message);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/jobs/dead - dead letter queue (register before /:id)
  // -------------------------------------------------------------------------
  app.get('/api/v1/jobs/dead', async (req, res) => {
    const rawLimit = req.query.limit === undefined ? 20 : parseInt(req.query.limit, 10);
    const rawOffset = req.query.offset === undefined ? 0 : parseInt(req.query.offset, 10);
    if (Number.isNaN(rawLimit) || Number.isNaN(rawOffset)) {
      return err(res, 400, 'INVALID_REQUEST', 'limit and offset must be integers');
    }
    if (rawLimit < 0 || rawOffset < 0) {
      return err(res, 400, 'INVALID_REQUEST', 'limit and offset must be non-negative');
    }
    const limit = Math.min(rawLimit, 100);
    const offset = rawOffset;

    // Optional server-side type filter. Filtering in the browser would only ever
    // see the current page, which reads as "no matches" when the job is really
    // sitting on page 2.
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const where = type ? "WHERE status = 'dead' AND type = $1" : "WHERE status = 'dead'";
    const params = type ? [type] : [];

    try {
      const countResult = await db.query(
        `SELECT COUNT(*)::int AS count FROM jobs ${where}`, params
      );
      const total = countResult.rows[0].count;

      const rows = await db.query(
        `SELECT * FROM jobs
         ${where}
         ORDER BY finished_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      return res.json({
        jobs: rows.rows.map(serializeDeadLetter),
        meta: {
          total,
          limit,
          offset,
          has_more: offset + limit < total,
          ...(type ? { type } : {}),
        },
      });
    } catch (error) {
      return err(res, 500, 'DATABASE_ERROR', error.message);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/jobs/:id - status polling
  // -------------------------------------------------------------------------
  app.get('/api/v1/jobs/:id', async (req, res) => {
    try {
      const rows = await db.query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
      if (rows.rows.length === 0) {
        return err(res, 404, 'NOT_FOUND', 'Job not found');
      }
      return res.json(serializeJob(rows.rows[0]));
    } catch (error) {
      return err(res, 500, 'DATABASE_ERROR', error.message);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/jobs/:id/retry - manual retry of a dead job
  // -------------------------------------------------------------------------
  app.post('/api/v1/jobs/:id/retry', async (req, res) => {
    try {
      const rows = await db.query(
        `UPDATE jobs
         SET status = 'pending',
             max_attempts = max_attempts + 2,
             run_at = NOW(),
             finished_at = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'dead'
         RETURNING *`,
        [req.params.id]
      );
      if (rows.rows.length === 0) {
        return err(res, 404, 'NOT_FOUND', 'Job not found or not in dead state');
      }
      const row = rows.rows[0];
      return res.status(202).json({
        job_id: row.id,
        status: row.status,
        attempts: row.attempts,
        max_attempts: row.max_attempts,
      });
    } catch (error) {
      return err(res, 500, 'DATABASE_ERROR', error.message);
    }
  });

  // -------------------------------------------------------------------------
  // Fallbacks
  // -------------------------------------------------------------------------
  app.use((req, res) => {
    err(res, 404, 'NOT_FOUND', 'Endpoint not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error && error.type === 'entity.parse.failed') {
      return err(res, 400, 'INVALID_REQUEST', 'Request body is not valid JSON');
    }
    return err(res, 500, 'DATABASE_ERROR', error.message || 'Internal server error');
  });

  return app;
}