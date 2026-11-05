/** Whether a private file's permission bits let other people on this computer read or change it. Windows keeps no
 * such bits: Node reports every file there as 0o666 (0o444 when read-only), so the check would refuse every saved key
 * and stop ros.ai from starting. There the person's own profile folder, which holds ros.ai's data, keeps others out. */
export function openToOthers(mode: number, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32' && (mode & 0o077) !== 0;
}
