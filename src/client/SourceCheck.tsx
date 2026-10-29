import { useEffect, useState } from 'react';
import { ExternalLink, Quote, RotateCcw } from 'lucide-react';
import type { SourceCheck } from '../shared/types';
import { VERDICT_ORDER, VERDICT_WORDS, checkTally } from '../shared/source-check';
import { date } from './Content';
import './source-check.css';

async function sha256(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** A block's claims as an agent marked them on the web, worst first, each with the words of the page it rests on.
 * Without a check, the block offers one. */
export function SourceCheckView({ check, text, onCheck }: { check?: SourceCheck; text: string; onCheck?: () => void }) {
  const [changed, setChanged] = useState(false);
  useEffect(() => { let live = true; if (check && crypto.subtle) void sha256(text).then(hash => { if (live) setChanged(hash !== check.textHash); }); return () => { live = false; }; }, [check, text]);
  if (!check) return onCheck && text.trim().length >= 80 ? <div className="source-check-offer"><button type="button" className="small secondary" title="ROS checks the claims on the web and marks each one here" onClick={onCheck}><Quote size={12}/> Check sources</button></div> : null;
  const tally = checkTally(check), claims = [...check.claims].sort((a, b) => VERDICT_ORDER.indexOf(a.verdict) - VERDICT_ORDER.indexOf(b.verdict));
  return <section className="source-check" aria-label="Sources checked">
    <div className="source-check-heading">
      <h3>Sources checked</h3>
      <small>{date(check.checkedAt)}{changed ? ' · the text changed since' : ''}</small>
      <span className="source-check-spacer"/>
      {onCheck && <button type="button" className="text-button small" onClick={onCheck}><RotateCcw size={12}/> Check again</button>}
    </div>
    <div className="check-tally">{VERDICT_ORDER.filter(verdict => tally[verdict] > 0).map(verdict => <span key={verdict} className={`claim-mark ${verdict}`}>{tally[verdict]} {VERDICT_WORDS[verdict].toLowerCase()}</span>)}</div>
    <ol className="claim-list">{claims.map((claim, index) => <li key={index}>
      <span className={`claim-mark ${claim.verdict}`}>{VERDICT_WORDS[claim.verdict]}</span>
      <div>
        <p className="claim-text">{claim.text}</p>
        {claim.note && <p className="claim-note">{claim.note}</p>}
        {claim.quote && <blockquote>“{claim.quote}”</blockquote>}
        {claim.source && (claim.source.url ? <a className="claim-source" href={claim.source.url} target="_blank" rel="noreferrer">{claim.source.title}<ExternalLink size={11}/></a> : <span className="claim-source">{claim.source.title}</span>)}
      </div>
    </li>)}</ol>
  </section>;
}
