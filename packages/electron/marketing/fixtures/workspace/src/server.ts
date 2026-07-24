import http from 'http';
import { WebSocketServer } from 'ws';
import { app } from './index';
import { createLogger } from './utils/logger';
import { handleWebSocketConnection } from './api/handlers';

const logger = createLogger('websocket');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const clientId = req.headers['x-client-id'] as string;
  logger.info(`Client connected: ${clientId}`);

  handleWebSocketConnection(ws, clientId);

  ws.on('close', () => {
    logger.info(`Client disconnected: ${clientId}`);
  });

  ws.on('error', (err) => {
    logger.error(`WebSocket error for ${clientId}:`, err);
  });
});

// Broadcast to all connected clients
export function broadcast(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data, timestamp: Date.now() });

  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

export { server };
