import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_DATA_DIR = resolve(process.cwd(), 'data', 'external');

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export class JsonFileStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {};
    this.loaded = false;
  }

  async _ensureLoaded() {
    if (!this.loaded) {
      try {
        this.data = JSON.parse(await readFile(this.filePath, 'utf8'));
      } catch {
        this.data = {};
      }
      this.loaded = true;
    }
  }

  async get(key) {
    await this._ensureLoaded();
    return this.data[key];
  }

  async set(key, value) {
    await this._ensureLoaded();
    this.data[key] = value;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await rename(tmp, this.filePath);
  }

  async reset() {
    this.loaded = false;
    this.data = {};
    try {
      await stat(this.filePath);
      await writeFile(this.filePath, '{}', 'utf8');
    } catch {
      // file does not exist yet; nothing to reset
    }
  }
}

/**
 * Simulated email provider (stands in for SendGrid / SES / Postmark).
 *
 * Real providers support server-side idempotency keys: submitting the same
 * key twice returns the existing send instead of sending a second email.
 * This simulation persists those keys to a JSON file so the behaviour holds
 * even across separate worker processes.
 */
export class EmailProvider {
  constructor(options = {}) {
    const dir = options.dataDir || DEFAULT_DATA_DIR;
    this.store = new JsonFileStore(join(dir, 'emails.json'));
    this.failNext = options.failNext || null;
  }

  async send({ to, subject, template, templateVars, idempotencyKey }) {
    if (!idempotencyKey) {
      throw new Error('EmailProvider requires an idempotencyKey (use the job id)');
    }
    await sleep(20 + Math.random() * 80); // simulate network latency
    const existing = await this.store.get(idempotencyKey);
    if (existing) {
      return { status: 'already_sent', messageId: existing.messageId, sendId: existing.sendId };
    }
    if (this.failNext) {
      const err = new Error(this.failNext);
      this.failNext = null;
      throw err;
    }
    const messageId = 'msg_' + randomUUID().replace(/-/g, '');
    const record = { to, subject, template, messageId, sendId: 'sid_' + randomUUID().slice(0, 13) };
    await this.store.set(idempotencyKey, record);
    return { status: 'sent', messageId: record.messageId };
  }
}

/**
 * Simulated payment provider (stands in for Stripe).
 * createCharge is idempotent on the key: the same key returns the same charge.
 */
export class PaymentProvider {
  constructor(options = {}) {
    this.charges = new Map();
    this.failNext = options.failNext || null;
  }

  async createCharge({ customerId, amount, currency, idempotencyKey }) {
    if (!idempotencyKey) {
      throw new Error('PaymentProvider requires an idempotencyKey (use the job id)');
    }
    await sleep(30 + Math.random() * 40);
    const existing = this.charges.get(idempotencyKey);
    if (existing) {
      return { ...existing, deduped: true };
    }
    if (this.failNext) {
      const err = new Error(this.failNext);
      this.failNext = null;
      throw err;
    }
    const charge = {
      id: 'ch_' + randomUUID().replace(/-/g, ''),
      customerId,
      amount,
      currency,
      status: 'succeeded',
    };
    this.charges.set(idempotencyKey, charge);
    return charge;
  }
}