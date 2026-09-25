import config from '../config/index.js';
import { query, closePool } from '../db/index.js';
import { buildHandlers } from './handlers.js';
import { createWorker } from './worker.js';

const workerId = `worker-${process.pid}`;
const handlers = buildHandlers({ query }, config.dataDir);

const worker = createWorker({
  config,
  db: { query },
  handlers,
  workerId,
});

console.log(
  `[${workerId}] starting: concurrency_cap=${config.concurrencyCap} max_attempts=${config.maxAttempts} ` +
    `backoff_base=${config.backoffBaseSeconds}s jitter=${config.backoffJitterPercent}% ` +
    `stuck_timeout=${config.stuckTimeoutSeconds}s cleanup_interval=${config.cleanupIntervalSeconds}s`
);

worker.start().catch((error) => {
  console.error(`[${workerId}] worker loop crashed: ${error.message}`);
  process.exit(1);
});

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${workerId}] ${signal} received, draining ${worker.inFlightCount} in-flight job(s)`);

    // Hard exit if a handler never returns, so a hung job cannot keep the
    // process alive forever. The stuck sweep will pick the job back up.
    const forceExit = setTimeout(() => {
      console.error(`[${workerId}] drain timed out, exiting anyway`);
      process.exit(1);
    }, 30000);
    forceExit.unref();

    await worker.stop();
    await closePool();
    clearTimeout(forceExit);
    process.exit(0);
  });
}
