import config from './config/index.js';
import { query, closePool } from './db/index.js';
import { buildApp } from './api/app.js';

const app = buildApp({ db: { query }, config });

const server = app.listen(config.port, () => {
  console.log(`[API] Listening on http://localhost:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`[API] Shutting down on ${signal}`);
    server.close(async () => {
      await closePool();
      process.exit(0);
    });
  });
}