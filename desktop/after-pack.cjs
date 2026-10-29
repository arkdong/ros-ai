// electron-builder afterPack hook. Without an Apple identity the packed app keeps Electron's own ad-hoc
// signatures, which the renamed bundle no longer matches, and a quarantined download then fails as
// "damaged" with no way to open it. Signing the whole bundle ad hoc again makes it a plain unsigned app:
// macOS says it cannot verify the developer and offers Open Anyway in Privacy & Security.
// A bundle signed with a real identity (Team ID set) is left alone.
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const codesign = (args) => spawnSync('codesign', args, { encoding: 'utf8' });

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const info = codesign(['-dv', '--verbose=2', app]);
  const details = `${info.stdout}${info.stderr}`;
  if (/^TeamIdentifier=(?!not set)\S+/m.test(details)) { console.log('  • keeping the Apple signature'); return; }
  console.log('  • no Apple identity: signing the app ad hoc so macOS offers Open Anyway');
  const signed = codesign(['--force', '--deep', '--sign', '-', '--timestamp=none', app]);
  if (signed.status !== 0) throw new Error(`ad-hoc codesign failed: ${signed.stderr}`);
  const check = codesign(['--verify', '--deep', '--strict', '--verbose=1', app]);
  if (check.status !== 0) throw new Error(`the ad-hoc signature does not verify: ${check.stderr}`);
};
