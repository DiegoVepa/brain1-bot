import { CronExpressionParser } from 'cron-parser';

import { ALLOWED_CHAT_ID } from './config.js';
import {
  getDueTasks,
  updateTaskAfterRun,
  updateTaskNextRun,
} from './db.js';
import { logger } from './logger.js';
import { runAgent } from './agent.js';
import { formatForTelegram, splitMessage } from './bot.js';

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

    // Advance next_run BEFORE execution to prevent duplicate firing.
    // The agent can take minutes; without this, the 60s interval re-fires the same task.
    const nextRun = computeNextRun(task.schedule);
    updateTaskNextRun(task.id, nextRun);

    try {
      // Run as a fresh agent call (no session — scheduled tasks are autonomous)
      // No start notification — only send the final result to keep Telegram clean.
      // Use task-specific model if set (e.g. Sonnet for content ideas), otherwise default (Opus)
      const result = await runAgent(task.prompt, undefined, () => {}, undefined, task.model ?? undefined);
      const text = result.text?.trim() || 'Task completed with no output.';

      // Prepend task name as header so Diego knows which cron produced this
      const header = `<b>${label}</b>\n\n`;
      const formatted = header + formatForTelegram(text);
      for (const chunk of splitMessage(formatted)) {
        await sender(chunk);
      }

      updateTaskAfterRun(task.id, nextRun, text);

      logger.info({ taskId: task.id, nextRun }, 'Task complete, next run scheduled');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');

      // next_run already advanced above; just record the failure
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
