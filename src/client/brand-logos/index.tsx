import arxiv from './arxiv.svg';
import brave from './brave.svg';
import claude from './claude.svg';
import codex from './codex.svg';
import exa from './exa.svg';
import figma from './figma.svg';
import geminiCli from './gemini-cli.svg';
import github from './github.svg';
import googleDocs from './google-docs.svg';
import googleDrive from './google-drive.svg';
import googleSheets from './google-sheets.svg';
import goose from './goose.svg';
import hermes from './hermes.svg';
import linear from './linear.svg';
import lmStudio from './lm-studio.svg';
import moonshot from './moonshot.svg';
import nebius from './nebius.svg';
import notion from './notion.svg';
import ollama from './ollama.svg';
import openai from './openai.svg';
import openalex from './openalex.svg';
import opencode from './opencode.svg';
import overleaf from './overleaf.svg';
import pi from './pi.svg';
import sentry from './sentry.svg';
import slack from './slack.svg';
import tavily from './tavily.svg';
import zotero from './zotero.svg';

/** Official company marks, copied unchanged from their sources (see SOURCES.md); each belongs to its owner. */
const logos = { arxiv, brave, claude, codex, exa, figma, 'gemini-cli': geminiCli, github, 'google-docs': googleDocs, 'google-drive': googleDrive, 'google-sheets': googleSheets, goose, hermes, linear, 'lm-studio': lmStudio, moonshot, nebius, notion, ollama, openai, openalex, opencode, overleaf, pi, sentry, slack, tavily, zotero };
export type BrandId = keyof typeof logos;
export const hasBrandLogo = (id: string): id is BrandId => id in logos;

export function BrandLogo({ id, size = 22 }: { id: BrandId; size?: number }) {
  return <img className="brand-logo" src={logos[id]} width={size} height={size} alt="" aria-hidden="true" draggable={false}/>;
}
