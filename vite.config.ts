import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { handleMikuChatEndRequest, handleMikuChatRequest } from './server/deepseek-miku.mjs';
import { handleVocaloidLyricsRequest, handleVocaloidSearchRequest } from './server/vocaloid-knowledge.mjs';
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
            server.middlewares.use('/api/miku-chat/end', (req, res) => {
              void handleMikuChatEndRequest(req, res);
            });
            server.middlewares.use('/api/miku-chat', (req, res) => {
              void handleMikuChatRequest(req, res);
            });
            server.middlewares.use('/api/vocaloid-search', (req, res) => {
              void handleVocaloidSearchRequest(req, res);
            });
            server.middlewares.use('/api/vocaloid-lyrics', (req, res) => {
              void handleVocaloidLyricsRequest(req, res);
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
