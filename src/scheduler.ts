import { CronExpressionParser } from 'cron-parser';

import { ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';
import { runAgent } from './agent.js';
import { formatForTelegram } from './bot.js';

type Sender = (text: string) => Promise<void>;

let sender: Sender;

/**
 * Initialise the scheduler. Call once after the Telegram bot is ready.
 * @param send  Function that sends a message to the user's Telegram chat.
 */
export function initScheduler(send: Sender): void {
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID not set — scheduler will not send results');
  }
  sender = send;
  setInterval(() => void runDueTasks(), 60_000);
  logger.info('Scheduler started (checking every 60s)');
}

async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks();
  if (tasks.length === 0) return;

  logger.info({ count: tasks.length }, 'Running due scheduled tasks');

  for (const task of tasks) {
    const label = task.name ?? task.id;
    logger.info({ taskId: task.id, label }, 'Firing task');

    try {
      await sender(`Running scheduled task: <b>${label}</b>`);

      // Run as a fresh agent call (no session — scheduled tasks are autonomous)
      // Use task-specific model if set (e.g. Sonnet for content ideas), otherwise default (Opus)
      const result = await runAgent(task.prompt, undefined, () => {}, undefined, task.model ?? undefined);
      const text = result.text?.trim() || 'Task completed with no output.';

      await sender(formatForTelegram(text));

      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, text);

      logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');

      // Always advance to next window — don't retry this window
      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, `FAILED: ${errMsg.slice(0, 200)}`);

      try {
        const nextDate = new Date(nextRun * 1000).toLocaleString('en-US', {
          month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
        });
        await sender(`Task failed: <b>${label}</b>. Next run: ${nextDate}`);
      } catch {
        // ignore send failure
      }
    }
  }
}

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpressionParser.parse(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}
