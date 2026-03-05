import fs from 'fs';
import path from 'path';

import { BRAIN1_ROOT, BRAIN_SHARED_ROOT } from './config.js';
import { logger } from './logger.js';

type Sender = (text: string) => Promise<void>;

const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// Track what we last saw so we only notify on changes
let lastBrain2Hash = '';
let lastTaskFiles: string[] = [];

/**
 * Start the brain-sync loop. Runs immediately, then every 30 minutes.
 * - Updates brain-shared/status/brain1.md with Paco's current state
 * - Checks brain-shared/status/brain2.md for changes from Benito
 * - Scans brain-shared/tasks/ for completed tasks
 * - Notifies on Telegram if something new is found
 */
export function startBrainSync(send: Sender): void {
  // Initialize last-seen state without notifying
  initLastSeen();

  // Run first heartbeat immediately (updates brain1.md)
  void runHeartbeat(send);

  // Then every 30 minutes
  setInterval(() => void runHeartbeat(send), HEARTBEAT_INTERVAL_MS);

  logger.info('Brain sync started (heartbeat every 30 min)');
}

function initLastSeen(): void {
  // Snapshot brain2 status so we don't notify on first run
  try {
    const brain2Path = path.join(BRAIN_SHARED_ROOT, 'status', 'brain2.md');
    lastBrain2Hash = safeReadHash(brain2Path);
  } catch {
    // No brain2.md yet, that's fine
  }

  // Snapshot current task files
  try {
    lastTaskFiles = listTaskFiles();
  } catch {
    lastTaskFiles = [];
  }
}

async function runHeartbeat(send: Sender): Promise<void> {
  try {
    updateBrain1Status();
    await checkBrain2Changes(send);
    await checkTaskChanges(send);
  } catch (err) {
    logger.error({ err }, 'Brain sync heartbeat failed');
  }
}

/**
 * Update brain-shared/status/brain1.md with current state.
 * Reads context.md for priorities summary.
 */
function updateBrain1Status(): void {
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Pull top priorities from context.md
  let prioritiesSummary = '- No context.md found';
  try {
    const contextPath = path.join(BRAIN1_ROOT, 'memory', 'context.md');
    const content = fs.readFileSync(contextPath, 'utf-8');
    // Extract first 5 bullet points or lines that look like priorities
    const lines = content.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));
    prioritiesSummary = lines.slice(0, 5).join('\n') || '- See context.md for details';
  } catch {
    // context.md not found
  }

  const statusContent = `# Brain 1 Status
Updated: ${now}

## Currently Active
- Paco bot running via LaunchAgent (auto-restart on crash/reboot)
- Session persistence active
- Scheduler running (60s check interval)

## Context.md Summary
${prioritiesSummary}

## Needs Input From Brain 2
- Awaiting first task assignment
`;

  const statusPath = path.join(BRAIN_SHARED_ROOT, 'status', 'brain1.md');
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, statusContent);

  logger.info('Updated brain1.md status');
}

/**
 * Check if brain2.md changed since last check. Notify if so.
 */
async function checkBrain2Changes(send: Sender): Promise<void> {
  const brain2Path = path.join(BRAIN_SHARED_ROOT, 'status', 'brain2.md');
  const currentHash = safeReadHash(brain2Path);

  if (!currentHash) return; // File doesn't exist yet
  if (currentHash === lastBrain2Hash) return; // No changes

  lastBrain2Hash = currentHash;

  try {
    const content = fs.readFileSync(brain2Path, 'utf-8');
    // Extract just the "Currently Working On" section if present
    const workingMatch = content.match(/## Currently Working On\n([\s\S]*?)(?=\n##|\n$|$)/);
    const summary = workingMatch?.[1]?.trim() || content.slice(0, 300);

    await send(`<b>Benito update detected</b>\n\n${summary}`);
    logger.info('Notified user of Brain 2 status change');
  } catch (err) {
    logger.error({ err }, 'Failed to notify about brain2 changes');
  }
}

/**
 * Check for new or changed task files in brain-shared/tasks/.
 * Notify about completed tasks or new tasks assigned to brain1.
 */
async function checkTaskChanges(send: Sender): Promise<void> {
  const currentFiles = listTaskFiles();

  // Find new files
  const newFiles = currentFiles.filter(f => !lastTaskFiles.includes(f));

  for (const file of newFiles) {
    try {
      const filePath = path.join(BRAIN_SHARED_ROOT, 'tasks', file);
      const content = fs.readFileSync(filePath, 'utf-8');

      // Check if this task is relevant to Brain 1
      const assignedToBrain1 = /Assigned:\s*brain1/i.test(content);
      const completedByBrain2 = /Status:\s*completed/i.test(content) && /Created:.*brain2/i.test(content);

      if (assignedToBrain1 || completedByBrain2) {
        const titleMatch = content.match(/^# Task:\s*(.+)/m);
        const title = titleMatch?.[1] || file;
        const statusMatch = content.match(/Status:\s*(\w+)/i);
        const status = statusMatch?.[1] || 'unknown';

        await send(`<b>New task in brain-shared</b>\n\n<b>${title}</b>\nStatus: ${status}\nFile: ${file}`);
        logger.info({ file, title, status }, 'Notified user of new task');
      }
    } catch (err) {
      logger.error({ err, file }, 'Failed to read task file');
    }
  }

  // Also check existing files for status changes (e.g. brain2 completed a task)
  for (const file of currentFiles) {
    if (newFiles.includes(file)) continue; // Already handled above
    try {
      const filePath = path.join(BRAIN_SHARED_ROOT, 'tasks', file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const hash = simpleHash(content);

      // We only track file list, not content hashes, so for now
      // just detect new files. Content change detection can be added later.
      void hash;
    } catch {
      // File may have been deleted between listing and reading
    }
  }

  lastTaskFiles = currentFiles;
}

/** List .md task files (excluding README.md). */
function listTaskFiles(): string[] {
  const tasksDir = path.join(BRAIN_SHARED_ROOT, 'tasks');
  try {
    return fs.readdirSync(tasksDir)
      .filter(f => f.endsWith('.md') && f !== 'README.md')
      .sort();
  } catch {
    return [];
  }
}

/** Read a file and return a simple hash, or empty string if missing. */
function safeReadHash(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return simpleHash(content);
  } catch {
    return '';
  }
}

/** Fast non-crypto hash for change detection. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return hash.toString(36);
}
