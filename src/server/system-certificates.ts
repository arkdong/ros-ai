import tls from 'node:tls';

/** Lets ros.ai's own requests trust the certificate authorities this computer trusts, on top of Node's built-in list,
 * the way browsers do. A company or school network that inspects secure connections (a FortiGate, Zscaler and the like)
 * re-signs them with its own authority, which its IT installs in the system store; without this, ros.ai cloud and
 * every model provider fail on that network while the browser works. Node 24.5 and later; older ones keep their list. */
export function trustSystemCertificates() {
  if (typeof tls.getCACertificates !== 'function' || typeof tls.setDefaultCACertificates !== 'function') return;
  try {
    const system = tls.getCACertificates('system');
    if (system.length) tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
  } catch (error) { console.warn(`ros.ai could not read this computer's certificates, so it uses Node's own list: ${error instanceof Error ? error.message : error}`); }
}
