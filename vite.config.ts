import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleAuthRequest, handleLeaderboardRequest, handleMikuMemoryRequest, handleRunStartRequest } from './server/auth-leaderboard.mjs';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    process.env.DEEPSEEK_API_KEY ||= env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_MODEL ||= env.DEEPSEEK_MODEL;
    process.env.DEEPSEEK_BASE_URL ||= env.DEEPSEEK_BASE_URL;
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        {
          name: 'local-miku-chat-api',
          configureServer(server) {
            server.middlewares.use('/api/miku-chat/end', (_req, res) => {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'CHAT_UNAVAILABLE' }));
            });
            server.middlewares.use('/api/miku-chat', (_req, res) => {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'CHAT_UNAVAILABLE' }));
            });
            server.middlewares.use('/api/vocaloid-search', (_req, res) => {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'LOOKUP_UNAVAILABLE' }));
            });
            server.middlewares.use('/api/vocaloid-lyrics', (_req, res) => {
              res.statusCode = 503;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'LOOKUP_UNAVAILABLE' }));
            });
            server.middlewares.use('/api/miku-memory', (req, res) => {
              void handleMikuMemoryRequest(req, res);
            });
            server.middlewares.use('/api/auth', (req, res) => {
              void handleAuthRequest(req, res);
            });
            server.middlewares.use('/api/runs/start', (req, res) => {
              void handleRunStartRequest(req, res);
            });
            server.middlewares.use('/api/leaderboard', (req, res) => {
              void handleLeaderboardRequest(req, res);
            });
          },
        },
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
