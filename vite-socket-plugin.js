// @ts-nocheck
import injectSocketIO from './socket-handler.js';

export const webSocketServer = {
	name: 'webSocketServer',
	configureServer(server) {
		injectSocketIO(server.httpServer);
	}
};
