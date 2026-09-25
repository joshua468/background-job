const LEVELS = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

const defaultSink = (line, level) => {
  // Warnings and errors go to stderr so they survive stdout redirection, which
  // is what makes `npm test | tee` usable.
  if (level === LEVELS.ERROR || level === LEVELS.WARN) {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
};

/**
 * Log line format, fixed by the spec:
 *   [TIMESTAMP] [LEVEL] [WORKER_ID] [JOB_ID] [JOB_TYPE] message
 * The sink is injectable so tests can capture lines without printing them.
 */
export function createLogger(workerId, options = {}) {
  const sink = options.sink || defaultSink;

  const write = (level, jobId, jobType, message) => {
    const ts = new Date().toISOString();
    const parts = [ts, level, workerId];
    if (jobId) parts.push(jobId);
    if (jobType) parts.push(jobType);
    parts.push(message);
    const line = parts.join(' ');
    sink(line, level);
    return line;
  };

  return {
    debug: (message, ctx = {}) => write(LEVELS.DEBUG, ctx.jobId, ctx.jobType, message),
    info: (message, ctx = {}) => write(LEVELS.INFO, ctx.jobId, ctx.jobType, message),
    warn: (message, ctx = {}) => write(LEVELS.WARN, ctx.jobId, ctx.jobType, message),
    error: (message, ctx = {}) => write(LEVELS.ERROR, ctx.jobId, ctx.jobType, message),
    _write: write,
  };
}
