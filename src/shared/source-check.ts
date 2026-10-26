import type { ClaimVerdict, SourceCheck } from './types.js';

/** How a claim's mark reads on a block, in the order the marks are listed. */
export const VERDICT_WORDS: Record<ClaimVerdict, string> = { contradicted: 'Contradicted', unsupported: 'No source', backed: 'Backed', open: 'Checking' };
export const VERDICT_ORDER: ClaimVerdict[] = ['contradicted', 'unsupported', 'backed', 'open'];

/** How many of a check's claims carry each mark. */
export function checkTally(check: SourceCheck): Record<ClaimVerdict, number> {
  const tally: Record<ClaimVerdict, number> = { backed: 0, contradicted: 0, unsupported: 0, open: 0 };
  for (const claim of check.claims) tally[claim.verdict]++;
  return tally;
}

/** What the Check sources button asks Ros, with the block in focus. */
export const checkSourcesRequest = (title: string) => `Check the sources of "${title}": pick its factual claims that matter most, check them on the web with ros_check_claims, read the pages that settle them, and mark every claim with ros_write_verdicts.`;
