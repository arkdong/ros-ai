import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2' };
export type KitFile = { type: string; body: Buffer };

/** The ros.ai kit App pages load from their frame's own address (/kit/...). It is built into dist/app-kit by
 * `npm run build` and the Mac app's build; a checkout's server builds it on first use when it is missing or older
 * than its sources, then serves it from memory. */
export class AppKit {
  private readonly files = new Map<string, KitFile>();
  private loading: Promise<void> | null = null;
  constructor(private readonly root: string) {}

  ready(): Promise<void> {
    return this.loading ??= (async () => {
      const script = resolve(this.root, 'scripts/build-app-kit.mjs');
      // The Mac app ships the kit built and without its sources.
      if (existsSync(resolve(this.root, 'src/app-kit/ros.ts')) && existsSync(script)) {
        const { buildAppKit } = await import(pathToFileURL(script).href) as { buildAppKit: (options: { root: string; onlyIfStale: boolean }) => Promise<boolean> };
        await buildAppKit({ root: this.root, onlyIfStale: true });
      }
      const dir = resolve(this.root, 'dist/app-kit');
      const walk = (folder: string, prefix: string) => {
        for (const name of readdirSync(folder)) {
          const path = join(folder, name);
          if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
          else if (TYPES[extname(name)]) this.files.set(`${prefix}${name}`, { type: TYPES[extname(name)], body: readFileSync(path) });
        }
      };
      walk(dir, '');
      if (!this.files.has('ros.js')) throw new Error('dist/app-kit has no ros.js. Run npm run build.');
    })().catch(error => { this.loading = null; this.files.clear(); throw error; });
  }
  /** A kit file by its path under /kit/, once the kit is ready. */
  file(name: string): KitFile | undefined { return this.files.get(name); }
}
