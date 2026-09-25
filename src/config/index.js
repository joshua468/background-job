import 'dotenv/config';
import { resolve } from 'node:path';

const parseIntEnv = (env, name, fallback) => {
  const raw = env[name];
  const value = raw === undefined ? fallback : parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  return value;
};

const parseFloatEnv = (env, name, fallback) => {
  const raw = env[name];
  const value = raw === undefined ? fallback : parseFloat(raw);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
};

export function loadConfig(env = process.env) {
  const config = {
    concurrencyCap: parseIntEnv(env, 'JOB_CONCURRENCY_CAP', 10),
    maxAttempts: parseIntEnv(env, 'JOB_MAX_ATTEMPTS', 5),
    claimIntervalSeconds: parseFloatEnv(env, 'JOB_CLAIM_INTERVAL_SECONDS', 2),
    backoffBaseSeconds: parseIntEnv(env, 'JOB_BACKOFF_BASE_SECONDS', 5),
    backoffJitterPercent: parseIntEnv(env, 'JOB_BACKOFF_JITTER_PERCENT', 10),
    stuckTimeoutSeconds: parseIntEnv(env, 'JOB_STUCK_TIMEOUT_SECONDS', 3600),
    cleanupIntervalSeconds: parseIntEnv(env, 'JOB_CLEANUP_INTERVAL_SECONDS', 300),
    heartbeatIntervalSeconds: parseIntEnv(env, 'JOB_HEARTBEAT_INTERVAL_SECONDS', 10),
    databaseUrl: env.DATABASE_URL,
    port: parseIntEnv(env, 'PORT', 3000),
    dataDir: env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(process.cwd(), 'data', 'external'),
  };

  const rules = [
    ['JOB_CONCURRENCY_CAP', config.concurrencyCap, (v) => v >= 1 && v <= 100, 'must be 1-100'],
    ['JOB_MAX_ATTEMPTS', config.maxAttempts, (v) => v >= 1 && v <= 20, 'must be 1-20'],
    ['JOB_CLAIM_INTERVAL_SECONDS', config.claimIntervalSeconds, (v) => v > 0, 'must be > 0'],
    ['JOB_BACKOFF_BASE_SECONDS', config.backoffBaseSeconds, (v) => v >= 1 && v <= 3600, 'must be 1-3600'],
    ['JOB_BACKOFF_JITTER_PERCENT', config.backoffJitterPercent, (v) => v >= 0 && v <= 100, 'must be 0-100'],
    ['JOB_STUCK_TIMEOUT_SECONDS', config.stuckTimeoutSeconds, (v) => v >= 1 && v <= 86400, 'must be 1-86400'],
    ['JOB_CLEANUP_INTERVAL_SECONDS', config.cleanupIntervalSeconds, (v) => v >= 1 && v <= 86400, 'must be 1-86400'],
    ['JOB_HEARTBEAT_INTERVAL_SECONDS', config.heartbeatIntervalSeconds, (v) => v >= 1 && v <= 3600, 'must be 1-3600'],
  ];

  const failures = [];
  for (const [name, value, valid, msg] of rules) {
    if (!valid(value)) {
      failures.push(`${name}=${value} ${msg}`);
    }
  }

  if (!config.databaseUrl) {
    failures.push('DATABASE_URL is required');
  } else {
    try {
      const url = new URL(config.databaseUrl);
      if (!url.protocol.match(/^postgres(ql)?:$/)) {
        failures.push(`DATABASE_URL must be a postgresql:// URL, got "${config.databaseUrl}"`);
      }
    } catch {
      failures.push(`DATABASE_URL is not a valid URL: ${config.databaseUrl}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid configuration:\n  - ${failures.join('\n  - ')}`);
  }

  return config;
}

export default loadConfig();