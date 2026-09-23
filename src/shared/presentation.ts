export type TextPreview = { text: string; truncated: boolean };

/** Display-only clipping. It normalizes whitespace without rewriting meaning or
 * changing the source. Consumers must keep the original available when clipped.
 */
export function textPreview(value: string, maxCharacters = 160): TextPreview {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 2) throw new RangeError('A text preview needs at least two characters.');
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= maxCharacters) return { text: normalized, truncated: false };
  const prefix = characters.slice(0, maxCharacters - 1).join('');
  const boundary = prefix.lastIndexOf(' ');
  // Prefer a whole word unless that would throw away most of the preview.
  const clipped = boundary >= prefix.length * .6 ? prefix.slice(0, boundary) : prefix;
  return { text: `${clipped.trimEnd()}…`, truncated: true };
}

export function notePreview(note: { title: string; description: string }) {
  const title = textPreview(note.title, 64);
  const description = textPreview(note.description, 140);
  return { title: title.text, description: description.text, titleTruncated: title.truncated, descriptionTruncated: description.truncated };
}
