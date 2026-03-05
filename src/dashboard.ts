import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { DASHBOARD_PORT, DASHBOARD_TOKEN, CONTEXT_LIMIT } from './config.js';
import {
  getAllScheduledTasks,
  getDashboardMemoryStats,
  getDashboardLowSalienceMemories,
  getDashboardTopAccessedMemories,
  getDashboardMemoryTimeline,
  getDashboardTokenStats,
  getDashboardCostTimeline,
  getDashboardRecentTokenUsage,
  getDashboardMemoriesBySector,
  getSession,
  getSessionTokenUsage,
} from './db.js';
import { getDashboardHtml } from './dashboard-html.js';
import { logger } from './logger.js';

export function startDashboard(): void {
  if (!DASHBOARD_TOKEN) {
    logger.info('DASHBOARD_TOKEN not set, dashboard disabled');
    return;
  }

  const app = new Hono();

  // Token auth middleware
  app.use('*', async (c, next) => {
    const token = c.req.query('token');
    if (token !== DASHBOARD_TOKEN) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });

  // Serve dashboard HTML
  app.get('/', (c) => {
    const chatId = c.req.query('chatId') || '';
    return c.html(getDashboardHtml(DASHBOARD_TOKEN, chatId));
  });

  // Scheduled tasks
  app.get('/api/tasks', (c) => {
    const tasks = getAllScheduledTasks();
    return c.json({ tasks });
  });

  // Memory stats
  app.get('/api/memories', (c) => {
    const chatId = c.req.query('chatId') || '';
    const stats = getDashboardMemoryStats(chatId);
    const fading = getDashboardLowSalienceMemories(chatId, 10);
    const topAccessed = getDashboardTopAccessedMemories(chatId, 5);
    const timeline = getDashboardMemoryTimeline(chatId, 30);
    return c.json({ stats, fading, topAccessed, timeline });
  });

  // Memory list by sector (for drill-down)
  app.get('/api/memories/list', (c) => {
    const chatId = c.req.query('chatId') || '';
    const sector = c.req.query('sector') || 'semantic';
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);
    const result = getDashboardMemoriesBySector(chatId, sector, limit, offset);
    return c.json(result);
  });

  // System health
  app.get('/api/health', (c) => {
    const chatId = c.req.query('chatId') || '';
    const sessionId = getSession(chatId);
    let contextPct = 0;
    let turns = 0;
    let compactions = 0;
    let sessionAge = '-';

    if (sessionId) {
      const summary = getSessionTokenUsage(sessionId);
      if (summary) {
        turns = summary.turns;
        compactions = summary.compactions;
        const contextTokens = summary.lastContextTokens || summary.lastCacheRead;
        contextPct = contextTokens > 0 ? Math.round((contextTokens / CONTEXT_LIMIT) * 100) : 0;
        const ageSec = Math.floor(Date.now() / 1000) - summary.firstTurnAt;
        if (ageSec < 3600) sessionAge = Math.floor(ageSec / 60) + 'm';
        else if (ageSec < 86400) sessionAge = Math.floor(ageSec / 3600) + 'h';
        else sessionAge = Math.floor(ageSec / 86400) + 'd';
      }
    }

    return c.json({
      contextPct,
      turns,
      compactions,
      sessionAge,
      waConnected: false,
      slackConnected: false,
    });
  });

  // Token / cost stats
  app.get('/api/tokens', (c) => {
    const chatId = c.req.query('chatId') || '';
    const stats = getDashboardTokenStats(chatId);
    const costTimeline = getDashboardCostTimeline(chatId, 30);
    const recentUsage = getDashboardRecentTokenUsage(chatId, 20);
    return c.json({ stats, costTimeline, recentUsage });
  });

  serve({ fetch: app.fetch, port: DASHBOARD_PORT }, () => {
    logger.info({ port: DASHBOARD_PORT }, 'Dashboard server running');
  });
}
