/**
 * LinkedIn Callback Handler — Processes InlineKeyboard button clicks
 *
 * Handles approve/skip/edit actions from Telegram buttons on LinkedIn
 * opportunity cards. Triggers execution when all items are decided.
 */

import type { Context } from 'grammy';
import { buildExecutePrompt, buildSkipPrompt } from './linkedin-approve.js';
import { isExpired } from './linkedin-batch-ttl.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface BatchState {
  items: Map<number, 'pending' | 'approved' | 'skipped' | 'expired'>;
  messageIds: Map<number, number>;  // itemIndex -> telegramMessageId
  summaryMessageId?: number;
  chatId: number;
  createdAt: number;
  allDecided: boolean;
  /** Set when an "Edit" button is clicked; next text message updates this item */
  pendingEditIndex?: number;
}

// In-memory batch state. Lost on restart (acceptable with 4h TTL + text fallback).
export const batchStates = new Map<string, BatchState>();

// ── Callback Handler ─────────────────────────────────────────────────

/**
 * Handle a callback_query from a LinkedIn inline button.
 * Returns the execution prompt if ready, or null if still collecting decisions.
 */
export async function handleLinkedInCallback(
  ctx: Context,
): Promise<{ prompt: string } | null> {
  const data = ctx.callbackQuery?.data;
  if (!data) {
    await ctx.answerCallbackQuery();
    return null;
  }

  // Parse: li:{action}:{batchId}:{index}
  const parts = data.split(':');
  if (parts.length < 3) {
    await ctx.answerCallbackQuery('Invalid action');
    return null;
  }

  const action = parts[1];
  const batchId = parts[2];
  const itemIndex = parts[3] ? parseInt(parts[3], 10) : undefined;

  const batch = batchStates.get(batchId);
  if (!batch) {
    await ctx.answerCallbackQuery('Batch not found. Use text reply instead.');
    return null;
  }

  if (isExpired(batch)) {
    await ctx.answerCallbackQuery('Batch expired.');
    return null;
  }

  switch (action) {
    case 'a': // approve single item
      return handleApprove(ctx, batch, batchId, itemIndex!);

    case 's': // skip single item
      return handleSkip(ctx, batch, batchId, itemIndex!);

    case 'e': // edit single item
      return handleEdit(ctx, batch, batchId, itemIndex!);

    case 'aa': // approve all
      return handleApproveAll(ctx, batch, batchId);

    case 'sa': // skip all
      return handleSkipAll(ctx, batch, batchId);

    default:
      await ctx.answerCallbackQuery('Unknown action');
      return null;
  }
}

// ── Action Handlers ──────────────────────────────────────────────────

async function handleApprove(
  ctx: Context,
  batch: BatchState,
  batchId: string,
  index: number,
): Promise<{ prompt: string } | null> {
  batch.items.set(index, 'approved');
  await ctx.answerCallbackQuery('Approved');

  // Edit the message to show approved state
  const messageId = batch.messageIds.get(index);
  if (messageId) {
    try {
      await ctx.api.editMessageReplyMarkup(batch.chatId, messageId, {
        reply_markup: undefined,
      });
      // Append a status indicator to the message text
      const originalMsg = ctx.callbackQuery?.message;
      if (originalMsg && 'text' in originalMsg) {
        const newText = (originalMsg as { text: string }).text + '\n\nApproved';
        await ctx.api.editMessageText(batch.chatId, messageId, newText, {
          parse_mode: 'HTML',
        });
      }
    } catch (err) {
      logger.warn({ err, index }, 'Failed to edit approved message');
    }
  }

  return checkAllDecided(batch, batchId);
}

async function handleSkip(
  ctx: Context,
  batch: BatchState,
  batchId: string,
  index: number,
): Promise<{ prompt: string } | null> {
  batch.items.set(index, 'skipped');
  await ctx.answerCallbackQuery('Skipped');

  const messageId = batch.messageIds.get(index);
  if (messageId) {
    try {
      await ctx.api.editMessageReplyMarkup(batch.chatId, messageId, {
        reply_markup: undefined,
      });
    } catch (err) {
      logger.warn({ err, index }, 'Failed to edit skipped message');
    }
  }

  return checkAllDecided(batch, batchId);
}

async function handleEdit(
  ctx: Context,
  batch: BatchState,
  _batchId: string,
  index: number,
): Promise<null> {
  batch.pendingEditIndex = index;
  await ctx.answerCallbackQuery(`Reply with: edit ${index}: your new text`);
  return null;
}

async function handleApproveAll(
  ctx: Context,
  batch: BatchState,
  batchId: string,
): Promise<{ prompt: string } | null> {
  for (const [idx, status] of batch.items) {
    if (status === 'pending') {
      batch.items.set(idx, 'approved');
    }
  }
  await ctx.answerCallbackQuery('All approved');

  // Remove keyboards from all opportunity messages
  for (const [, messageId] of batch.messageIds) {
    try {
      await ctx.api.editMessageReplyMarkup(batch.chatId, messageId, {
        reply_markup: undefined,
      });
    } catch {
      // Best effort
    }
  }

  return checkAllDecided(batch, batchId);
}

async function handleSkipAll(
  ctx: Context,
  batch: BatchState,
  batchId: string,
): Promise<{ prompt: string } | null> {
  for (const [idx, status] of batch.items) {
    if (status === 'pending') {
      batch.items.set(idx, 'skipped');
    }
  }
  await ctx.answerCallbackQuery('Batch skipped');

  for (const [, messageId] of batch.messageIds) {
    try {
      await ctx.api.editMessageReplyMarkup(batch.chatId, messageId, {
        reply_markup: undefined,
      });
    } catch {
      // Best effort
    }
  }

  return checkAllDecided(batch, batchId);
}

// ── Helpers ──────────────────────────────────────────────────────────

function checkAllDecided(
  batch: BatchState,
  batchId: string,
): { prompt: string } | null {
  const allDecided = [...batch.items.values()].every(s => s !== 'pending');
  if (!allDecided) return null;

  batch.allDecided = true;

  // Build the approval string for execution
  const approved = [...batch.items.entries()]
    .filter(([, s]) => s === 'approved')
    .map(([idx]) => idx);

  if (approved.length === 0) {
    logger.info({ batchId }, 'All items skipped');
    return { prompt: buildSkipPrompt() };
  }

  // Check if all items were approved
  const total = batch.items.size;
  if (approved.length === total) {
    logger.info({ batchId, approved: 'all' }, 'All items approved via buttons');
    return { prompt: buildExecutePrompt('all') };
  }

  const approvalStr = approved.join(',');
  logger.info({ batchId, approved: approvalStr }, 'Items approved via buttons');
  return { prompt: buildExecutePrompt(approvalStr) };
}
