/** What a File block can show: a PDF, a PNG, JPEG, WebP or GIF image, or an MP4 or MOV video, read from the project folder. */
export const FILE_TYPES: Record<string, string> = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };
export const FILE_EXTENSIONS = Object.keys(FILE_TYPES);
/** The largest PDF or image a File block shows or a drop saves into the folder. */
export const FILE_BYTES = 50_000_000;
/** The largest video a File block shows. A video is streamed in parts and never read whole, so it may be far larger. */
export const VIDEO_BYTES = 4_000_000_000;
/** The kinds of file a File block shows, for messages. */
export const FILE_KINDS_TEXT = 'PDF, PNG, JPEG, WebP, GIF, MP4 and MOV files';
/** The media type of a file a File block can show, by its extension; undefined for any other file. */
export function fileMediaType(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path, dot = name.lastIndexOf('.');
  return dot > 0 ? FILE_TYPES[name.slice(dot).toLowerCase()] : undefined;
}
export const isPdfType = (mediaType: string | undefined) => mediaType === 'application/pdf';
export const isImageType = (mediaType: string | undefined) => Boolean(mediaType?.startsWith('image/'));
export const isVideoType = (mediaType: string | undefined) => Boolean(mediaType?.startsWith('video/'));
/** The largest file of this path's type that a File block shows. */
export const fileLimit = (path: string) => isVideoType(fileMediaType(path)) ? VIDEO_BYTES : FILE_BYTES;
/** PDF, PNG, JPEG, WebP, GIF, MP4 or MOV: the file's type as a card or footer names it. */
export const fileTypeName = (mediaType: string) => isPdfType(mediaType) ? 'PDF' : ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF', 'video/mp4': 'MP4', 'video/quicktime': 'MOV' } as Record<string, string>)[mediaType] ?? 'File';
/** 0:42, 12:05, 1:02:09: a video's length. */
export const videoLength = (seconds: number) => { const whole = Math.max(0, Math.round(seconds)), h = Math.floor(whole / 3600), m = Math.floor(whole / 60) % 60, s = String(whole % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`; };
/** The pixel size of an image as a browser shows it, so after any rotation its EXIF data asks for. */
export type ImageSize = { width: number; height: number };
/** A File block that shows a picture or a video. On the map it is the picture or video itself, with no frame of its
 * own, and it keeps the picture's shape: its height follows its width, so a saved height is not used. */
export const isPictureNode = (node: { kind?: string; blockType?: string; file?: { path: string } | null }) => node.kind !== 'group' && node.blockType === 'file' && (media => isImageType(media) || isVideoType(media))(fileMediaType(node.file?.path ?? ''));
/** The address a File block's bytes are read from. */
export const fileUrl = (projectId: string, nodeId: string) => `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/file`;
/** 1.2 MB, 340 KB: the size line on a card. */
export const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
/** Images a Text block shows inline when its Markdown embeds them: `![alt](photos/a.png)` or `![[a.png]]`. */
export const NOTE_IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
export function noteImageType(path: string): string | undefined {
  const name = path.split('/').at(-1) ?? path, dot = name.lastIndexOf('.');
  return dot > 0 ? NOTE_IMAGE_TYPES[name.slice(dot).toLowerCase()] : undefined;
}
/** The address an embedded image in a Text block is read from: a path in the project folder, next to the block's file or from the folder's top. */
export const noteImageUrl = (projectId: string, nodeId: string, src: string) => `/api/projects/${encodeURIComponent(projectId)}/nodes/${encodeURIComponent(nodeId)}/image?src=${encodeURIComponent(src)}`;
