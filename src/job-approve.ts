/**
 * Job Approval Handler
 *
 * Detects when Diego replies to a job alert batch via Telegram
 * with approval patterns (e.g. "apply 1,3", "save 2", "skip all").
 *
 * Returns a structured prompt for the Claude agent to execute the
 * approved job actions, or null if the message isn't a job approval.
 */

import fs from 'fs';

const JOB_QUEUE_PATH = '/Users/diegovences/co-writter/linkedin/job-pending-queue.md';
const JOB_TRACKER_PATH = '/Users/diegovences/co-writter/linkedin/job-tracker.csv';
const SHEETS_CONFIG_PATH = '/Users/diegovences/.claude/skills/job-alerts/references/sheets-config.md';

/** Read the Google Sheet ID from config, or null if not set up yet */
function getSpreadsheetId(): string | null {
  try {
    const content = fs.readFileSync(SHEETS_CONFIG_PATH, 'utf-8');
    const match = content.match(/SPREADSHEET_ID:\s*(.+)/);
    const id = match ? match[1].trim() : null;
    return id && id.length > 5 ? id : null;
  } catch {
    return null;
  }
}

/** Build the Sheet update instruction block (or empty string if no Sheet) */
function sheetUpdateBlock(statusLabel: string): string {
  const sheetId = getSpreadsheetId();
  if (!sheetId) return '';
  return `
SHEET UPDATE: Read the spreadsheet ID from ${SHEETS_CONFIG_PATH}.
For each updated job, append a status row to the Google Sheet:
gws sheets +append --spreadsheet ${sheetId} --range 'Jobs' --values '["DATE","SCORE","TIER","COMPANY","TITLE","LOCATION","URL","H1B","${statusLabel}","Updated via Telegram","CONTACT"]'
If the gws command fails, log the error and continue. The CSV is the backup.`;
}

/** Get the Sheet URL for confirmation messages */
export function getSheetLink(): string {
  const sheetId = getSpreadsheetId();
  return sheetId ? `\nTracker: https://docs.google.com/spreadsheets/d/${sheetId}` : '';
}

/** Check if a pending job queue exists and has actionable items */
function hasPendingJobBatch(): boolean {
  try {
    const content = fs.readFileSync(JOB_QUEUE_PATH, 'utf-8');
    return content.includes('**Status:** pending') ||
           content.includes('[1]') ||
           (content.includes('JOB ALERTS') && !content.includes('No pending job alerts'));
  } catch {
    return false;
  }
}

/** Patterns that indicate a job approval reply */
const JOB_PATTERNS = {
  apply: /^apply\s+[\d,\s]+$/i,
  save: /^save\s+[\d,\s]+$/i,
  skipAll: /^skip\s+all$/i,
};

export interface JobApprovalResult {
  type: 'apply' | 'save' | 'skip';
  raw: string;
  prompt: string;
}

/**
 * Try to parse a Telegram message as a job approval.
 * Returns a JobApprovalResult with the execution prompt, or null if not a job approval.
 */
export function parseJobApproval(message: string): JobApprovalResult | null {
  const trimmed = message.trim();

  if (!hasPendingJobBatch()) return null;

  if (JOB_PATTERNS.skipAll.test(trimmed)) {
    return {
      type: 'skip',
      raw: trimmed,
      prompt: buildJobSkipPrompt(),
    };
  }

  if (JOB_PATTERNS.apply.test(trimmed)) {
    const numbers = trimmed.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      return {
        type: 'apply',
        raw: trimmed,
        prompt: buildJobApplyPrompt(numbers.join(',')),
      };
    }
  }

  if (JOB_PATTERNS.save.test(trimmed)) {
    const numbers = trimmed.match(/\d+/g);
    if (numbers && numbers.length > 0) {
      return {
        type: 'save',
        raw: trimmed,
        prompt: buildJobSavePrompt(numbers.join(',')),
      };
    }
  }

  return null;
}

function buildJobApplyPrompt(items: string): string {
  return `Diego wants to apply to specific jobs from the job alert batch.

STEP 1: Read the job pending queue at ${JOB_QUEUE_PATH}

STEP 2: Diego selected these items to apply to: ${items}

STEP 3: For each selected job:
1. Read the job URL from the pending queue
2. Open the job listing in a browser using playwright-cli:
   playwright-cli -s=linkedin open --persistent
   playwright-cli -s=linkedin goto "JOB_URL"
3. Take a snapshot to see the page:
   playwright-cli -s=linkedin snapshot
4. Look for the "Apply" or "Easy Apply" button and click it
5. If it's an Easy Apply form, fill in what you can and submit
6. If it redirects to an external site, just report the external URL to Diego
7. Wait 30-60s between applications (anti-detection)

STEP 4: Update ${JOB_TRACKER_PATH} for each applied job:
- Set status to "applied"
- Add today's date as a note
${sheetUpdateBlock('applied')}

STEP 5: Update ${JOB_QUEUE_PATH} — mark the batch as processed

STEP 6: Send confirmation to Diego:
"Applied to [N] positions: [Title] @ [Company], [Title] @ [Company]. Logged to tracker."${getSheetLink() ? `\nInclude this link: ${getSheetLink()}` : ''}

IMPORTANT:
- This is PRIVATE. Do not post anything on LinkedIn about job searching.
- If any application fails, skip it and note the failure.
- Close the browser when done: playwright-cli -s=linkedin close`;
}

function buildJobSavePrompt(items: string): string {
  return `Diego wants to save specific jobs for later review.

STEP 1: Read the job pending queue at ${JOB_QUEUE_PATH}

STEP 2: Diego selected these items to save: ${items}

STEP 3: Update ${JOB_TRACKER_PATH} for each saved job:
- Set status to "saved"
${sheetUpdateBlock('saved')}

STEP 4: Update ${JOB_QUEUE_PATH} — mark the processed items

STEP 5: Reply: "Saved [N] positions for later. You can review them anytime."${getSheetLink() ? `\nInclude this link: ${getSheetLink()}` : ''}`;
}

function buildJobSkipPrompt(): string {
  return `Diego chose to skip all jobs in the current batch.

1. Read ${JOB_QUEUE_PATH}
2. Update all jobs in the current batch in ${JOB_TRACKER_PATH} with status "skipped"
${sheetUpdateBlock('skipped')}
3. Clear the pending queue
4. Reply: "Job batch skipped. Next scan tomorrow at 8 AM."${getSheetLink() ? `\nInclude this link: ${getSheetLink()}` : ''}`;
}
