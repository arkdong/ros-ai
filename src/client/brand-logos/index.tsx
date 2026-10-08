import claude from './claude.svg';
import codex from './codex.svg';
import github from './github.svg';
import googleDocs from './google-docs.svg';
import googleDrive from './google-drive.svg';
import lmStudio from './lm-studio.svg';
import moonshot from './moonshot.svg';
import nebius from './nebius.svg';
import notion from './notion.svg';
import ollama from './ollama.svg';
import openai from './openai.svg';
import overleaf from './overleaf.svg';
import slack from './slack.svg';
import tavily from './tavily.svg';
import zotero from './zotero.svg';

/** Official company marks, copied unchanged from their sources (see SOURCES.md); each belongs to its owner. */
const logos = { claude, codex, github, 'google-docs': googleDocs, 'google-drive': googleDrive, 'lm-studio': lmStudio, moonshot, nebius, notion, ollama, openai, overleaf, slack, tavily, zotero };
export type BrandId = keyof typeof logos;
export const hasBrandLogo = (id: string): id is BrandId => id in logos;

export function BrandLogo({ id, size = 22 }: { id: BrandId; size?: number }) {
  return <img className="brand-logo" src={logos[id]} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
}
