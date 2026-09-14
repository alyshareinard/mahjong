// @ts-nocheck
import http from 'http';
import express from 'express';
import injectSocketIO from './socket-handler.js';
import { handler } from './build/handler.js';

const app = express();
const server = http.createServer(app);

injectSocketIO(server);

app.use(handler);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
});
