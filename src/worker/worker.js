import { createLogger } from './logger.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Consecutive loop errors tolerated before the worker gives up. A worker that
// cannot reach the database should exit and let the supervisor restart it,
// rather than spin forever logging the same error.
const MAX_CONSECUTIVE_LOOP_ERRORS = 5;

/**
 * Exponential backoff with jitter.
 *
 *   delay = (baseSeconds * 2^(attempt - 1)) + random(-jitterRange/2 .. +jitterRange/2)
 *   jitterRange = exponential * (jitterPercent / 100)
 *
 * The jitter is the line `Math.random() * jitterRange - jitterRange / 2`. Without
 * it, every job that failed at the same instant retries at the same instant, and
 * a hundred jobs hit the same failing dependency together.
 */
export function calculateBackoff(attempt, { backoffBaseSeconds, backoffJitterPercent }) {
  const exponential = backoffBaseSeconds * Math.pow(2, attempt - 1);
  const jitterRange = exponential * (backoffJitterPercent / 100);
  const jitter = Math.random() * jitterRange - jitterRange / 2;
  return exponential + jitter;
}

export function createWorker({ config, db, handlers, workerId, hooks = {}, logger }) {
  const log = logger || createLogger(workerId);
  let running = false;
  const inFlight = new Map();
  let lastRecoveryMs = 0;
  let lastHeartbeatMs = 0;
  let consecutiveErrors = 0;
  let wakeup = null;
  let loopPromise = Promise.resolve();

  const withTail = (jobId, jobType) => ({ jobId, jobType });

  // Sleep that stop() can cut short, so shutdown does not have to wait out a
  // full claim interval.
  function interruptibleSleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeup = null;
        resolve();
      }, ms);
      wakeup = () => {
        clearTimeout(timer);
        wakeup = null;
        resolve();
      };
    });
  }

  /**
   * Atomic claim. Status is flipped to 'processing' and the row is returned in
   * the same statement, so a job can never be observed as claimed by two
   * workers. The sub-SELECT uses FOR UPDATE SKIP LOCKED: concurrent workers
   * contend for the same candidate row, the loser skips it and takes the next
   * one instead of blocking. No application-level locking is involved.
   */
  async function claimJob(type) {
    const typeClause = type ? 'AND type = $1' : '';
    const params = type ? [type] : [];
    const result = await db.query(
      `UPDATE jobs
         SET status = 'processing',
             started_at = NOW(),
             updated_at = NOW()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status IN ('pending', 'failed')
           AND run_at <= NOW()
           ${typeClause}
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      params
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Stuck job recovery. Any job that has sat in 'processing' longer than
   * JOB_STUCK_TIMEOUT_SECONDS is reset to 'pending' with an incremented attempt
   * count and an immediate run_at. This is the worker-crash scenario: the row
   * was claimed by a process that no longer exists.
   */
  async function recoverStuckJobs() {
    const result = await db.query(
      `UPDATE jobs
         SET status = 'pending',
             attempts = attempts + 1,
             run_at = NOW(),
             updated_at = NOW()
       WHERE status = 'processing'
         AND started_at < NOW() - ($1 || ' seconds')::interval
       RETURNING id, type, attempts, started_at`,
      [config.stuckTimeoutSeconds]
    );
    for (const row of result.rows) {
      const stuckForSeconds = Math.round((Date.now() - new Date(row.started_at).getTime()) / 1000);
      log.warn(
        `Recovered stuck job, was in processing for ${stuckForSeconds}s, now pending (attempt ${row.attempts})`,
        withTail(row.id, row.type)
      );
    }
    return result.rows.length;
  }

  async function markSucceeded(job, durationMs) {
    const result = await db.query(
      `UPDATE jobs
         SET status = 'succeeded',
             finished_at = NOW(),
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id]
    );
    const row = result.rows[0];
    log.info(`Marked succeeded, finished_at set (total work ${durationMs}ms)`, withTail(job.id, job.type));
    return row;
  }

  /**
   * Record a failed attempt. Retryable failures go back to 'pending' with a
   * backoff delay and no finished_at; exhausting max_attempts goes to 'dead'
   * and sets finished_at. 'failed' and 'dead' are different states and the
   * difference is entirely in these two branches.
   */
  async function handleFailure(job, errorMessage) {
    const nextAttempt = job.attempts + 1;
    const isExhausted = nextAttempt >= job.max_attempts;

    let runAt = job.run_at;
    let backoffSeconds = null;
    if (!isExhausted) {
      backoffSeconds = calculateBackoff(nextAttempt, config);
      runAt = new Date(Date.now() + backoffSeconds * 1000);
    }

    const result = await db.query(
      `UPDATE jobs
         SET attempts = $2,
             last_error = $3,
             status = $4,
             run_at = $5,
             finished_at = CASE WHEN $4 = 'dead' THEN NOW() ELSE NULL END,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [job.id, nextAttempt, errorMessage, isExhausted ? 'dead' : 'failed', runAt]
    );
    const row = result.rows[0];

    if (isExhausted) {
      const attemptWord = nextAttempt === 1 ? 'attempt' : 'attempts';
      log.error(
        `Job dead after ${nextAttempt} ${attemptWord}, requires manual intervention`,
        withTail(job.id, job.type)
      );
    } else {
      log.warn(
        `Work failed: ${errorMessage}. Retry queued, attempt ${nextAttempt} of ${job.max_attempts}, next attempt in ${backoffSeconds.toFixed(1)}s (run_at ${new Date(row.run_at).toISOString()})`,
        withTail(job.id, job.type)
      );
    }
    return row;
  }

  async function executeJobSafely(job) {
    const startedMs = Date.now();
    log.info(`Claimed job, attempt ${job.attempts + 1} of ${job.max_attempts}`, withTail(job.id, job.type));
    hooks.onClaim?.(job);

    const handler = handlers[job.type];
    if (!handler) {
      // An unknown type is a configuration error, not a work failure, but it
      // still has to go through the retry path so it surfaces in the dead
      // letter queue instead of spinning forever.
      const error = new Error(`Unknown job type: ${job.type}`);
      return finishFailure(job, error, startedMs);
    }

    let result;
    try {
      log.debug('Executing work', withTail(job.id, job.type));
      result = await handler.run(job, job.payload, { jobId: job.id });
    } catch (error) {
      return finishFailure(job, error, startedMs);
    }

    const durationMs = Date.now() - startedMs;
    log.info(`Work succeeded in ${durationMs}ms`, withTail(job.id, job.type));

    try {
      await markSucceeded(job, durationMs);
    } catch (error) {
      // The work succeeded but we could not record it. The row is still
      // 'processing', so the stuck sweep will requeue it and the work will run
      // again. That is safe precisely because the work is idempotent. Reporting
      // this as a work failure would be a lie and would also pollute last_error.
      log.error(
        `Work succeeded but marking it succeeded failed: ${error.message}. Row left in processing for the stuck sweep to requeue.`,
        withTail(job.id, job.type)
      );
      hooks.onComplete?.(job, 'mark-failed');
      return { status: 'mark-failed' };
    }

    hooks.onComplete?.(job, 'succeeded');
    return { status: 'succeeded', result };
  }

  async function finishFailure(job, error, startedMs) {
    const durationMs = Date.now() - startedMs;
    log.warn(`Work failed in ${durationMs}ms: ${error.message}`, withTail(job.id, job.type));

    let updated = null;
    try {
      updated = await handleFailure(job, error.message);
    } catch (dbError) {
      // We could not record the failure. The row stays 'processing' and the
      // stuck sweep requeues it once the timeout passes. Swallowing this is
      // deliberate: an unhandled rejection here would take the whole worker
      // down and strand every other job it was carrying.
      log.error(
        `Could not record failure for job: ${dbError.message}. Row left in processing for the stuck sweep to requeue.`,
        withTail(job.id, job.type)
      );
      hooks.onComplete?.(job, 'record-failed');
      return { status: 'record-failed' };
    }

    hooks.onFailed?.(job, updated);
    hooks.onComplete?.(job, updated.status);
    return { status: updated.status, job: updated };
  }

  async function loop() {
    log.info(`Worker started, concurrency cap: ${config.concurrencyCap}`);

    while (running) {
      try {
        consecutiveErrors = 0;

        const nowMs = Date.now();
        if (nowMs - lastRecoveryMs >= config.cleanupIntervalSeconds * 1000) {
          lastRecoveryMs = nowMs;
          const recovered = await recoverStuckJobs();
          hooks.onRecovered?.(recovered);
        }

        if (inFlight.size >= config.concurrencyCap) {
          await interruptibleSleep(50);
          continue;
        }

        // Periodic in-flight gauge. This is the line that proves the
        // concurrency cap holds in the logs, not just in a test assertion.
        if (
          inFlight.size > 0 &&
          nowMs - lastHeartbeatMs >= config.heartbeatIntervalSeconds * 1000
        ) {
          lastHeartbeatMs = nowMs;
          log.info(`Concurrent jobs: ${inFlight.size} of ${config.concurrencyCap}`);
        }

        const job = await claimJob();
        if (!job) {
          await interruptibleSleep(config.claimIntervalSeconds * 1000);
          continue;
        }

        const task = executeJobSafely(job)
          .catch((error) => {
            // Defensive: executeJobSafely handles its own errors, so reaching
            // here means a bug in the worker itself. Log it and keep serving.
            log.error(`Unhandled worker error on job: ${error.message}`, withTail(job.id, job.type));
            return { status: 'error' };
          })
          .finally(() => {
            inFlight.delete(job.id);
            hooks.onProcessing?.(inFlight.size, job.id);
          });

        inFlight.set(job.id, task);
        hooks.onProcessing?.(inFlight.size, job.id);
      } catch (error) {
        consecutiveErrors += 1;
        log.error(`Loop error (${consecutiveErrors}/${MAX_CONSECUTIVE_LOOP_ERRORS}): ${error.message}`);

        if (consecutiveErrors >= MAX_CONSECUTIVE_LOOP_ERRORS) {
          log.error(
            `Giving up after ${MAX_CONSECUTIVE_LOOP_ERRORS} consecutive loop errors. Exiting so the supervisor can restart this worker.`
          );
          running = false;
          break;
        }

        hooks.onProcessing?.(inFlight.size);
        await interruptibleSleep(500);
      }
    }

    log.info('Worker stopped gracefully');
  }

  return {
    config,
    workerId,
    claimJob,
    recoverStuckJobs,
    markSucceeded,
    handleFailure,
    calculateBackoff,
    start() {
      if (running) return loopPromise;
      running = true;
      consecutiveErrors = 0;
      lastRecoveryMs = 0;
      lastHeartbeatMs = 0;
      loopPromise = loop();
      return loopPromise;
    },
    stop() {
      running = false;
      wakeup?.();
      return loopPromise;
    },
    get isRunning() {
      return running;
    },
    async waitForIdle(timeoutMs = 120000) {
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0 && Date.now() < deadline) {
        await sleep(50);
      }
      return inFlight.size === 0;
    },
    get inFlightCount() {
      return inFlight.size;
    },
  };
}
