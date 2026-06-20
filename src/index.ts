import { createServer } from './api/server.js';
import logger from './lib/logger.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const app = createServer();

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'server listening');
});
