import { createServer } from './api/server.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const app = createServer();

app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
});
