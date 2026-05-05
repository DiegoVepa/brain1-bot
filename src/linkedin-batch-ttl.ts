/**
 * LinkedIn Batch TTL — Auto-expiry for stale approval batches
 *
 * Ensures morning batches don't block evening scans.
 * Default TTL: 4 hours.
 */

import fs from 'fs';
import type { Context } from 'grammy';
import type { BatchState } from './linkedin-callback.js';

const PENDING_QUEUE_PATH = '/Users/diegovences/co-writter/linkedin/pending-queue.md';
const TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Check if a batch has expired (older than TTL).
 */
export function isExpired(batch: BatchState): boolean {
  return Date.now() - batch.createdAt > TTL_MS;
}

/**
 * Extract the batch timestamp from the pending-queue.md file.
 * Returns epoch ms or null if no pending batch.
 */
export function parseBatchTimestamp(): number | null {
  try {
    const content = fs.readFileSync(PENDING_QUEUE_PATH, 'utf-8');
    if (!content.includes('**Status:** pending_approval')) return null;

    const generatedMatch = content.match(/\*\*Generated:\*\*\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}\s*(?:AM|PM))\s+PT/i);
    if (!generatedMatch) return null;

    const [, datePart, timePart] = generatedMatch;
    // Parse the date + time in PT
    const dateStr = `${datePart} ${timePart}`;
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) return null;

    return parsed.getTime();
  } catch {
    return null;
  }
}

/**
 * Check if the file-based pending batch is expired.
 * Used by linkedin-approve.ts to skip stale batches.
 */
export function isFileBatchExpired(): boolean {
  const timestamp = parseBatchTimestamp();
  if (timestamp === null) return false;
  return Date.now() - timestamp > TTL_MS;
}

/**
 * Expire all pending in-memory batches when a new scan arrives.
 * Edits the Telegram summary message to indicate expiry.
 */
export async function expireOnNewScan(
  batchStates: Map<string, BatchState>,
  ctx: Context,
): Promise<void> {
  for (const [id, batch] of batchStates) {
    if (batch.allDecided) continue;

    // Edit the summary message to show expired
    if (batch.summaryMessageId) {
      try {
        await ctx.api.editMessageText(
          batch.chatId,
          batch.summaryMessageId,
          `Batch expired. Replaced by new scan.`,
        );
      } catch {
        // Message may have been deleted or too old to edit
      }
    }

    // Mark all pending items as expired
    for (const [itemIdx, status] of batch.items) {
      if (status === 'pending') {
        batch.items.set(itemIdx, 'expired');
      }
    }
    batch.allDecided = true;
  }

  // Update file status
  updateFileStatus('expired');
}

/**
 * Update pending-queue.md batch status.
 */
export function updateFileStatus(newStatus: string): void {
  try {
    let content = fs.readFileSync(PENDING_QUEUE_PATH, 'utf-8');
    content = content.replace(
      /\*\*Status:\*\* pending_approval/,
      `**Status:** ${newStatus}`,
    );
    fs.writeFileSync(PENDING_QUEUE_PATH, content, 'utf-8');
  } catch {
    // Non-blocking
  }
}
