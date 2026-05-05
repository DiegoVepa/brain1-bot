/**
 * LinkedIn Buttons — Rich Telegram presentation layer
 *
 * Parses pending-queue.md and builds individual Telegram messages
 * with InlineKeyboard buttons for each LinkedIn engagement opportunity.
 */

import fs from 'fs';
import { InlineKeyboard } from 'grammy';

const PENDING_QUEUE_PATH = '/Users/diegovences/co-writter/linkedin/pending-queue.md';

// ── Types ────────────────────────────────────────────────────────────

export interface LinkedInOpportunity {
  index: number;
  person: string;
  title: string;
  company: string;
  icpScore: number;
  tier: 'reactive' | 'proactive';
  actionType: string;
  postSummary: string;
  draft: string;
  connectionNote?: string;
  interactionCount: number;
  relationshipStage: string;
  whyNow: string;
}

export interface WarmingSignal {
  person: string;
  titleAndCompany: string;
  signal: string;
  icpScore: number;
  stage: string;
  action: string;
}

export interface ParsedBatch {
  batchId: string;
  generatedAt: string;
  opportunities: LinkedInOpportunity[];
  warmingSignals: WarmingSignal[];
}

// ── Parsing ──────────────────────────────────────────────────────────

/**
 * Parse the pending batch from pending-queue.md.
 * Finds the batch with `pending_approval` status, which may not be the first
 * batch in the file (newer no_new_opportunities batches get prepended above it).
 */
export function parsePendingQueue(): ParsedBatch | null {
  let content: string;
  try {
    content = fs.readFileSync(PENDING_QUEUE_PATH, 'utf-8');
  } catch {
    return null;
  }

  const pendingIdx = content.indexOf('**Status:** pending_approval');
  if (pendingIdx === -1) return null;

  // Find the batch ID closest BEFORE the pending_approval status
  const beforePending = content.slice(0, pendingIdx);
  const allBatchIds = [...beforePending.matchAll(/\*\*Batch ID:\*\*\s*(batch-[\d-]+)/g)];
  if (allBatchIds.length === 0) return null;
  const batchId = allBatchIds[allBatchIds.length - 1][1];

  // Find the generated timestamp near this batch
  const allGenerated = [...beforePending.matchAll(/\*\*Generated:\*\*\s*(.+)/g)];
  const generatedAt = allGenerated.length > 0 ? allGenerated[allGenerated.length - 1][1] : '';

  // Slice from the batch header to the next --- separator after pending_approval
  const batchHeaderIdx = beforePending.lastIndexOf('**Batch ID:**');
  const batchEnd = content.indexOf('\n---\n', pendingIdx);
  const batchSection = batchEnd > 0
    ? content.slice(batchHeaderIdx, batchEnd)
    : content.slice(batchHeaderIdx);

  // Parse warming signals
  const warmingSignals = parseWarmingSignals(batchSection);

  // Parse opportunities (### [score] [action_type] -- Name ...)
  const opportunities = parseOpportunities(batchSection);

  if (opportunities.length === 0 && warmingSignals.length === 0) return null;

  return { batchId, generatedAt, opportunities, warmingSignals };
}

function parseWarmingSignals(section: string): WarmingSignal[] {
  const signals: WarmingSignal[] = [];

  // Match the WARMING SIGNALS section
  const warmingMatch = section.match(/### WARMING SIGNALS\n([\s\S]*?)(?=\n### \[|$)/);
  if (!warmingMatch) return signals;

  const warmingBlock = warmingMatch[1];

  // Each signal starts with **Name** (Title)
  const signalBlocks = warmingBlock.split(/\n\*\*(?=[A-Z])/).filter(b => b.trim());

  for (const block of signalBlocks) {
    const nameMatch = block.match(/^(.+?)\*\*\s*\((.+?)\)/);
    if (!nameMatch) continue;

    const signalMatch = block.match(/Signal:\s*(.+)/);
    const icpMatch = block.match(/ICP:\s*(\d+)/);
    const stageMatch = block.match(/Stage:\s*(.+?)(?:\n|$)/);
    const actionMatch = block.match(/Action:\s*(.+)/);

    signals.push({
      person: nameMatch[1].trim(),
      titleAndCompany: nameMatch[2].trim(),
      signal: signalMatch?.[1]?.trim() ?? 'Unknown signal',
      icpScore: parseInt(icpMatch?.[1] ?? '0', 10),
      stage: stageMatch?.[1]?.trim() ?? 'unknown',
      action: actionMatch?.[1]?.trim() ?? 'Watch for next interaction',
    });
  }

  return signals;
}

function parseOpportunities(section: string): LinkedInOpportunity[] {
  const opportunities: LinkedInOpportunity[] = [];

  // Match opportunity blocks: ### [score] [action_type] -- Name (Title)
  const oppPattern = /### \[(\d+)\] \[(\w+)\] -- (.+)/g;
  let match: RegExpExecArray | null;
  let index = 1;

  while ((match = oppPattern.exec(section)) !== null) {
    const score = parseInt(match[1], 10);
    const actionType = match[2];
    const nameAndTitle = match[3];

    // Extract the block content until next ### or end
    const blockStart = match.index + match[0].length;
    const nextHeader = section.indexOf('\n### ', blockStart);
    const blockEnd = nextHeader > 0 ? nextHeader : section.length;
    const block = section.slice(blockStart, blockEnd);

    // Parse person details from the header
    const personMatch = nameAndTitle.match(/^(.+?)\s*\((.+)\)/);
    const person = personMatch?.[1]?.trim() ?? nameAndTitle.trim();
    const fullTitle = personMatch?.[2]?.trim() ?? '';

    // Split title into role and company
    const titleParts = fullTitle.split(/\s*[@|]\s*/);
    const title = titleParts[0]?.trim() ?? '';
    const company = titleParts.slice(1).join(' @ ').trim();

    // Determine tier
    const isReactive = block.toLowerCase().includes('tier 1 reactive') ||
                       block.toLowerCase().includes('commented on diego') ||
                       block.toLowerCase().includes('mentioned diego');
    const tier: 'reactive' | 'proactive' = isReactive ? 'reactive' : 'proactive';

    // Extract post summary
    const postMatch = block.match(/\*\*Post:\*\*\s*(.+)/);
    const commentMatch = block.match(/\*\*His comment:\*\*\s*(.+)/);
    const postSummary = postMatch?.[1]?.trim() ?? commentMatch?.[1]?.trim() ?? '';

    // Extract draft
    const draftMatch = block.match(/\*\*Draft(?:\s*reply)?:\*\*\s*"(.+?)"/s) ||
                       block.match(/\*\*Draft:\*\*\s*"(.+?)"/s);
    const draft = draftMatch?.[1]?.trim() ?? '';

    // Extract interaction count
    const historyMatch = block.match(/(\d+)\s*entr(?:y|ies)/);
    const interactionCount = parseInt(historyMatch?.[1] ?? '0', 10);

    // Extract stage
    const stageMatch = block.match(/\*\*Stage:\*\*\s*(\w+)/);
    const relationshipStage = stageMatch?.[1]?.trim() ?? 'unknown';

    // Derive why-now context
    const whyNow = deriveWhyNow(actionType, interactionCount, relationshipStage, tier, block);

    opportunities.push({
      index,
      person,
      title,
      company,
      icpScore: score,
      tier,
      actionType,
      postSummary,
      draft,
      interactionCount,
      relationshipStage,
      whyNow,
    });

    index++;
  }

  return opportunities;
}

// ── Why Now ──────────────────────────────────────────────────────────

function deriveWhyNow(
  actionType: string,
  interactionCount: number,
  stage: string,
  tier: 'reactive' | 'proactive',
  blockText: string,
): string {
  const parts: string[] = [];

  // Tier context
  if (tier === 'reactive') {
    parts.push('They engaged with your content. Reply velocity matters.');
  }

  // Touchpoint progression
  if (interactionCount > 0) {
    const ordinal = interactionCount + 1;
    const suffix = ordinal === 2 ? '2nd' : ordinal === 3 ? '3rd' : `${ordinal}th`;
    parts.push(`${suffix} touchpoint.`);

    if (stage === 'building' && ordinal >= 3) {
      parts.push('One inbound signal triggers warm stage.');
    }
  }

  // Timing urgency
  const timeMatch = blockText.match(/(\d+)\s*min\s*ago/);
  if (timeMatch) {
    parts.push(`Posted ${timeMatch[1]} min ago. Fresh content gets more visibility.`);
  }

  // Unhandled urgency
  const unhandledMatch = blockText.match(/UNHANDLED\s*since\s*~?(\d+)d\s*ago/i);
  if (unhandledMatch) {
    parts.push(`Unhandled for ${unhandledMatch[1]} days. Reply gap growing.`);
  }

  if (parts.length === 0) {
    parts.push('Good opportunity to build the relationship.');
  }

  return parts.join(' ');
}

// ── Card Builders ────────────────────────────────────────────────────

export function buildOpportunityCard(
  opp: LinkedInOpportunity,
  batchId: string,
): { text: string; keyboard: InlineKeyboard } {
  const tierLabel = opp.tier === 'reactive' ? 'REACTIVE' : 'PROACTIVE';
  const stageLabel = opp.relationshipStage !== 'unknown' ? opp.relationshipStage : '';
  const touchpointLabel = opp.interactionCount > 0
    ? `${opp.interactionCount + 1}${opp.interactionCount + 1 === 2 ? 'nd' : opp.interactionCount + 1 === 3 ? 'rd' : 'th'} touchpoint`
    : 'New contact';

  let text = `<b>${opp.index}. ${escapeHtml(opp.person)}</b> - ${escapeHtml(opp.title)}`;
  if (opp.company) text += ` @ ${escapeHtml(opp.company)}`;
  text += `\n`;
  text += `ICP: ${opp.icpScore} | ${tierLabel} | ${touchpointLabel}`;
  if (stageLabel) text += ` | ${stageLabel}`;
  text += `\n\n`;
  text += `<b>Why now:</b> ${escapeHtml(opp.whyNow)}\n\n`;

  if (opp.postSummary) {
    const truncatedPost = opp.postSummary.length > 200
      ? opp.postSummary.slice(0, 197) + '...'
      : opp.postSummary;
    text += `<b>Post:</b> ${escapeHtml(truncatedPost)}\n\n`;
  }

  if (opp.draft) {
    const truncatedDraft = opp.draft.length > 400
      ? opp.draft.slice(0, 397) + '...'
      : opp.draft;
    text += `<b>Draft:</b> "${escapeHtml(truncatedDraft)}"`;
  }

  const keyboard = new InlineKeyboard()
    .text('Approve', `li:a:${batchId}:${opp.index}`)
    .text('Edit', `li:e:${batchId}:${opp.index}`)
    .text('Skip', `li:s:${batchId}:${opp.index}`);

  return { text, keyboard };
}

export function buildWarmingCard(signal: WarmingSignal): string {
  let text = `<b>WARMING</b> - ${escapeHtml(signal.person)} (${escapeHtml(signal.titleAndCompany)})\n`;
  text += `Signal: ${escapeHtml(signal.signal)}\n`;
  text += `ICP: ${signal.icpScore} | Stage: ${escapeHtml(signal.stage)}\n`;
  text += `Next move: ${escapeHtml(signal.action)}`;
  return text;
}

export function buildBatchSummary(
  batchId: string,
  opportunityCount: number,
): { text: string; keyboard: InlineKeyboard } {
  const text = `${opportunityCount} opportunit${opportunityCount === 1 ? 'y' : 'ies'} ready. ` +
    `Tap buttons above or reply with numbers (e.g. 1,2).`;

  const keyboard = new InlineKeyboard()
    .text('Approve All', `li:aa:${batchId}`)
    .text('Skip All', `li:sa:${batchId}`);

  return { text, keyboard };
}

// ── Helpers ──────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
