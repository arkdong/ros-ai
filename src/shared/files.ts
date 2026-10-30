/** What a File block can show: a PDF or a PNG, JPEG, WebP or GIF image, read from the project folder. */
export const FILE_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export const FILE_EXTENSIONS = Object.keys(FILE_TYPES);
/** The largest file a File block shows or a drop saves into the folder. */
export const FILE_BYTES = 50_000_000;
/** The media type of a file a File block can show, by its extension; undefined for any other file. */
export function fileMediaType(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path, dot = name.lastIndexOf('.');
  return dot > 0 ? FILE_TYPES[name.slice(dot).toLowerCase()] : undefined;
}
export const isPdfType = (mediaType: string | undefined) => mediaType === 'application/pdf';
export const isImageType = (mediaType: string | undefined) => Boolean(mediaType?.startsWith('image/'));
/** PDF, PNG, JPEG, WebP or GIF: the file's type as a card or footer names it. */
export const fileTypeName = (mediaType: string) => isPdfType(mediaType) ? 'PDF' : ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF' } as Record<string, string>)[mediaType] ?? 'File';
/** The pixel size of an image as a browser shows it, so after any rotation its EXIF data asks for. */
export type ImageSize = { width: number; height: number };
/** A File block that shows a picture. On the map it is the picture itself, with no frame of its own, and it keeps
 * the picture's shape: its height follows its width, so a saved height is not used. */
export const isPictureNode = (node: { kind?: string; blockType?: string; file?: { path: string } | null }) => node.kind !== 'group' && node.blockType === 'file' && isImageType(fileMediaType(node.file?.path ?? ''));
/** The address a File block's bytes are read from. */
export const fileUrl = (projectId: string, nodeId: string) => `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/file`;
/** 1.2 MB, 340 KB: the size line on a card. */
export const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/** Images a Text block shows inline when its Markdown embeds them: `![alt](photos/a.png)` or `![[a.png]]`. */
export const NOTE_IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
export function noteImageType(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path, dot = name.lastIndexOf('.');
  return dot > 0 ? NOTE_IMAGE_TYPES[name.slice(dot).toLowerCase()] : undefined;
}
/** The address an embedded image in a Text block is read from: a path in the project folder, next to the block's file or from the folder's top. */
export const noteImageUrl = (projectId: string, nodeId: string, src: string) => `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/image?src=${encodeURIComponent(src)}`;
