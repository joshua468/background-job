import { join } from 'node:path';
import { EmailProvider, PaymentProvider, JsonFileStore, DEFAULT_DATA_DIR } from './external.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OPTIONS = {
  send_email: {
    strategy:
      'Option A - provider-side idempotency key. The email provider is called with idempotencyKey = job.id. ' +
      'If the worker dies after sending but before marking the job done, the retry hits the provider with the same key ' +
      'and the provider returns the existing send instead of sending a second email.',
  },
  generate_pdf: {
    strategy:
      'Option B - store output by job id. Output is keyed on job.id (pdf_<job id>). Before generating, check whether the ' +
      'output already exists; if it does, return the stored result. A double run is wasteful but harmless and returns the same bytes.',
  },
  charge_card: {
    strategy:
      'Option C - database dedupe. The authoritative output is the charges row, keyed on job.id. The handler checks for an ' +
      'existing charge before charging, and the insert is idempotent (ON CONFLICT DO NOTHING). Re-execution can never charge twice.',
  },
  slow_work: {
    strategy: 'Test fixture - sleeps for payload.delayMs then succeeds. Used to exercise the concurrency cap.',
  },
  quick_work: {
    strategy: 'Test fixture - completes instantly. Used for multi-worker collision tests.',
  },
  always_fails: {
    strategy: 'Test fixture - throws on every execution. Used to exhaust a job through retries into the dead state.',
  },
  hang_forever: {
    strategy: 'Test fixture - never resolves. Used to simulate a worker dying mid-job so stuck recovery can be proven.',
  },
};

export function createHandlers({ db, providers }) {
  return {
    send_email: {
      strategy: OPTIONS.send_email.strategy,
      async run(job, payload) {
        if (!payload.to || !payload.subject) {
          throw new Error('send_email requires payload.to and payload.subject');
        }
        return providers.email.send({
          to: payload.to,
          subject: payload.subject,
          template: payload.template || 'generic',
          templateVars: payload.template_vars || {},
          idempotencyKey: job.id,
        });
      },
    },

    generate_pdf: {
      strategy: OPTIONS.generate_pdf.strategy,
      async run(job, payload) {
        const key = `pdf_${job.id}`;
        const existing = await providers.fileStore.get(key);
        if (existing) {
          return { ...existing, cached: true };
        }
        if (!payload.content) {
          throw new Error('generate_pdf requires payload.content');
        }
        await sleep(40 + Math.random() * 60);
        const size = Buffer.byteLength(JSON.stringify(payload.content));
        const record = { key, size, format: payload.format || 'A4', generatedAt: new Date().toISOString() };
        await providers.fileStore.set(key, record);
        return { ...record, cached: false };
      },
    },

    charge_card: {
      strategy: OPTIONS.charge_card.strategy,
      async run(job, payload) {
        if (!payload.customerId || !Number.isInteger(payload.amount) || payload.amount <= 0) {
          throw new Error('charge_card requires payload.customerId and a positive integer payload.amount (minor units)');
        }
        const existingRow = await db.query('SELECT job_id, charge_id FROM charges WHERE job_id = $1', [job.id]);
        if (existingRow.rows.length > 0) {
          return { chargeId: existingRow.rows[0].charge_id, deduped: true };
        }

        const charge = await providers.payment.createCharge({
          customerId: payload.customerId,
          amount: payload.amount,
          currency: payload.currency || 'usd',
          idempotencyKey: job.id,
        });

        await db.query(
          'INSERT INTO charges (job_id, charge_id) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING',
          [job.id, charge.id]
        );

        const stored = await db.query('SELECT job_id, charge_id FROM charges WHERE job_id = $1', [job.id]);
        const chargeId = stored.rows[0] ? stored.rows[0].charge_id : charge.id;
        return { chargeId, status: charge.status, deduped: false };
      },
    },

    slow_work: {
      strategy: OPTIONS.slow_work.strategy,
      async run(job, payload) {
        await sleep(payload.delayMs || 0);
        return { marker: 'slow_work completed' };
      },
    },

    quick_work: {
      strategy: OPTIONS.quick_work.strategy,
      async run() {
        return { ok: true, at: new Date().toISOString() };
      },
    },

    always_fails: {
      strategy: OPTIONS.always_fails.strategy,
      async run(job, payload) {
        throw new Error(payload.message || 'Simulated always-fails error');
      },
    },

    hang_forever: {
      strategy: OPTIONS.hang_forever.strategy,
      async run() {
        return new Promise(() => {});
      },
    },
  };
}

export function buildProviders(dataDir) {
  const dir = dataDir || DEFAULT_DATA_DIR;
  return {
    email: new EmailProvider({ dataDir: dir }),
    payment: new PaymentProvider(),
    fileStore: new JsonFileStore(join(dir, 'pdfs.json')),
  };
}

export function buildHandlers(db, dataDir) {
  return createHandlers({ db, providers: buildProviders(dataDir) });
}