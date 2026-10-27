/** The feedback card's three kinds of note, in the order it shows them. */
export const FEEDBACK_KINDS = [
  { id: 'problem', label: 'Problem', hint: 'What happened, and what did you expect?' },
  { id: 'idea', label: 'Idea', hint: 'What would make ros.ai better for you?' },
  { id: 'question', label: 'Question', hint: 'What would you like to know?' },
] as const;
export type FeedbackKind = typeof FEEDBACK_KINDS[number]['id'];
export const FEEDBACK_MAX_CHARS = 5000;

/** One note as the card sends it. The email is only for people who are not signed in and want a
 * reply; the details line only goes when its box is ticked. */
export type FeedbackNote = { kind: FeedbackKind; message: string; email?: string; details?: string };

/** What the card learns from the local server when it opens, without calling ros.ai cloud: whether
 * Send can reach the cloud, the signed-in email replies go to, and the server's half of the
 * app-details line (the browser adds its own name). */
export type FeedbackSetup = { cloud: boolean; email?: string; details: string };

/** "Problem: the note's first line", cut to fit an issue list: at a word, unless that word is long. */
export function feedbackTitle(kind: FeedbackKind, message: string) {
  const label = FEEDBACK_KINDS.find(item => item.id === kind)?.label ?? 'Feedback';
  const line = message.trim().split('\n', 1)[0].trim();
  if (line.length <= 72) return `${label}: ${line}`;
  const cut = line.slice(0, 73).replace(/\s+\S*$/u, '');
  return `${label}: ${(cut.length >= 48 && cut.length <= 72 ? cut : line.slice(0, 72)).trimEnd()}…`;
}

/** A new public issue in arkdong/ros-ai, filled in through the issue form for the note's kind
 * (.github/ISSUE_TEMPLATE). It never carries the email address, and a long note is cut so the
 * link stays short enough for GitHub to open. */
export function publicIssueUrl(note: Omit<FeedbackNote, 'email'>) {
  const url = new URL('https://github.com/arkdong/ros-ai/issues/new');
  const message = note.message.trim();
  url.searchParams.set('template', `${note.kind}.yml`);
  if (message) url.searchParams.set('title', feedbackTitle(note.kind, message));
  url.searchParams.set('message', message.length > 3000 ? `${message.slice(0, 3000)}…` : message);
  if (note.details) url.searchParams.set('details', note.details);
  return url.href;
}
