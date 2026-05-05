/**
 * LinkedIn Approval Handler
 *
 * Detects when Diego replies to a LinkedIn scan batch via Telegram
 * with approval patterns (e.g. "1,2,5", "all", "skip", "edit 1: ...").
 *
 * Returns a structured prompt for the Claude agent to execute the
 * approved LinkedIn actions, or null if the message isn't an approval.
 */

import fs from 'fs';
import path from 'path';
import { isFileBatchExpired } from './linkedin-batch-ttl.js';

const PENDING_QUEUE_PATH = '/Users/diegovences/co-writter/linkedin/pending-queue.md';

/** Check if a pending queue exists and has a non-empty, non-expired batch */
function hasPendingBatch(): boolean {
  try {
    const content = fs.readFileSync(PENDING_QUEUE_PATH, 'utf-8');
    const hasPending = content.includes('**Status:** pending_approval') ||
           content.includes('Draft:') ||
           // Also match the formatted drafts from scan output
           (content.includes('batch-') && !content.includes('**Status:** empty'));
    if (!hasPending) return false;
    // Skip stale batches older than TTL
    if (isFileBatchExpired()) return false;
    return true;
  } catch {
    return false;
  }
}

/** Patterns that indicate a LinkedIn approval reply */
const APPROVAL_PATTERNS = {
  // "1,2,5" or "1, 2, 5" or "1 2 5" or "1c,2,3c" (c = comment+connect)
  numbers: /^[\dc,\s]+$/,
  // "all"
  all: /^all$/i,
  // "skip"
  skip: /^skip$/i,
  // "edit 1: new text here"
  edit: /^edit\s+\d+\s*:\s*.+/i,
};

export interface ApprovalResult {
  type: 'numbers' | 'all' | 'skip' | 'edit';
  raw: string;
  prompt: string;
}

/**
 * Try to parse a Telegram message as a LinkedIn approval.
 * Returns an ApprovalResult with the execution prompt, or null if not an approval.
 */
export function parseLinkedInApproval(message: string): ApprovalResult | null {
  const trimmed = message.trim();

  // Only check if there's a pending batch
  if (!hasPendingBatch()) return null;

  // Skip — acknowledge and clear queue
  if (APPROVAL_PATTERNS.skip.test(trimmed)) {
    return {
      type: 'skip',
      raw: trimmed,
      prompt: buildSkipPrompt(),
    };
  }

  // All — approve everything
  if (APPROVAL_PATTERNS.all.test(trimmed)) {
    return {
      type: 'all',
      raw: trimmed,
      prompt: buildExecutePrompt('all'),
    };
  }

  // Edit — modify a specific draft
  if (APPROVAL_PATTERNS.edit.test(trimmed)) {
    return {
      type: 'edit',
      raw: trimmed,
      prompt: buildEditPrompt(trimmed),
    };
  }

  // Numbers — approve specific items
  if (APPROVAL_PATTERNS.numbers.test(trimmed)) {
    // Validate it actually contains at least one number
    const numbers = trimmed.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      return {
        type: 'numbers',
        raw: trimmed,
        prompt: buildExecutePrompt(trimmed),
      };
    }
  }

  return null;
}

export function buildExecutePrompt(approvedItems: string): string {
  return `You are executing approved LinkedIn engagement actions from a pending queue.

STEP 1: Read the pending queue at ${PENDING_QUEUE_PATH}

STEP 2: Diego approved these items: ${approvedItems === 'all' ? 'ALL items in the batch' : `items numbered ${approvedItems}`}

STEP 3: For each approved item, post it on LinkedIn using playwright-cli (browser automation via Bash tool).

Use the "linkedin" named session with persistent profile. The session has saved LinkedIn auth cookies.

For EACH approved item, run these commands in sequence:

a) Open browser (only once, reuse for all items):
   playwright-cli -s=linkedin open --persistent

b) Navigate to the LinkedIn URL from the pending queue:
   playwright-cli -s=linkedin goto "THE_LINKEDIN_URL"

c) Take a snapshot to see the page and find the comment input field:
   playwright-cli -s=linkedin snapshot

d) If the snapshot shows a login page instead of LinkedIn content, STOP and reply:
   "LinkedIn session expired. Diego needs to re-auth. Run: playwright-cli -s=linkedin open https://linkedin.com/login --browser=chrome --persistent --headed"

e) Click the comment/reply input field (use the ref from snapshot, e.g. e5):
   playwright-cli -s=linkedin click eN

f) Type the approved draft text:
   playwright-cli -s=linkedin type "THE DRAFT TEXT"

g) Take another snapshot to find the submit/Comment/Reply button:
   playwright-cli -s=linkedin snapshot

h) Click the submit button:
   playwright-cli -s=linkedin click eN

i) Wait 30-60 seconds before the next item (anti-detection):
   sleep 45

j) Repeat b-i for each approved item.

k) Close when done:
   playwright-cli -s=linkedin close

IMPORTANT RULES:
- NEVER use em dashes in any text you type on LinkedIn. Use periods, commas, natural phrasing.
- If a comment fails to post, skip it and move to the next one.
- Max 15 actions per session.
- If LinkedIn shows any error or restriction warning, STOP immediately and report.
- Always take a snapshot after navigating to verify you're on the right page.

STEP 4: After executing, log each action to /Users/diegovences/co-writter/linkedin/interaction-log.csv
Format: date,person,company,title,action_type,content_summary,icp_score,h1b_sponsor,relationship_stage

STEP 5: Update the pending queue status to "executed" in ${PENDING_QUEUE_PATH}

STEP 6: Send a confirmation summary. Keep it short:
"Posted [N] replies: [Name1] ([Company]), [Name2] ([Company]). Logged to tracker."`;
}

export function buildSkipPrompt(): string {
  return `Diego chose to skip the current LinkedIn engagement batch.

1. Read ${PENDING_QUEUE_PATH}
2. Update the batch status to "skipped"
3. Reply: "Batch skipped. Next scan will run at the scheduled time."`;
}

function buildEditPrompt(editCommand: string): string {
  return `Diego wants to edit a LinkedIn draft before posting.

His edit command: "${editCommand}"

1. Read ${PENDING_QUEUE_PATH}
2. Parse the edit command. Format is "edit N: new text" where N is the item number.
3. Update that item's draft text in the pending queue file.
4. Send the updated draft back to Telegram for confirmation:
   "Updated draft #N: [new text]. Reply 'all' or item numbers to approve."

IMPORTANT: NEVER use em dashes in any draft text.`;
}
