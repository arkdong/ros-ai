import { existsSync, readFileSync } from 'node:fs';
import type { Artifact } from '../shared/types.js';

/** Server-only, attributed captures. These files never enter the public asset build. */
export type TutorialScenarioId = 'banking' | 'market';
export interface TutorialSavedOutput {
  kind: Artifact['kind']; title: string; content: string; mediaType: string;
  provenance: { originalArtifactId: string; originalRunId: string; originalCreatedAt: string; originalHash: string; provider?:string; model?:string; backend?:unknown };
}
export interface TutorialScenarioContent {
  id: TutorialScenarioId; title: string; summary: string; question: string; focusedQuestion: string;
  stages: { title: string; description: string }[];
  sources: { title: string; url: string; content: string }[];
  dataset: { title: string; csv: string; provenance: string };
  analysis: { title: string; request: string; code: string; parameters: Record<string, string | number | boolean> };
  reference: { findings: string; draft: string; provenance: string; outputs: TutorialSavedOutput[] };
  draftGuide: string; draftNarrative: string;
  publicDataReady: boolean; publicDataStatus: string;
}
const exampleUrl = (path: string) => new URL(`../../examples/${path}`, import.meta.url);
const readExample = (path: string) => readFileSync(exampleUrl(path), 'utf8');
// The market captures are gitignored local research data, so fresh clones lack them.
const marketFiles = ['demo-market-risk/source/fred-sp500-2018-2021.csv', 'demo-market-risk/research-v2/paper.md', 'tutorial-results/market.json'];
export const localMarketDataAvailable = () => marketFiles.every(path => existsSync(exampleUrl(path)));
const savedOutputs = (id: TutorialScenarioId): TutorialSavedOutput[] => JSON.parse(readExample(`tutorial-results/${id}.json`));
const cbsUrl = 'https://www.cbs.nl/en-gb/longread/aanvullende-statistische-diensten/2025/ai-monitor-2024/2-use-of-ai-technology-by-dutch-companies';
const fredUrl = 'https://fred.stlouisfed.org/series/SP500';

function banking(): TutorialScenarioContent {
  // Run the two existing, reviewed phases together only when a visitor explicitly
  // requests a new calculation. The imported outputs keep their two original runs.
  const originalCode = readExample('dutch-ai-adoption/analysis.py');
  const combinedCode = 'for tutorial_phase in ["overview", "challenge"]:\n' + originalCode
    .replace("phase = params.get('phase', 'overview')", 'phase = tutorial_phase')
    .split('\n').map(line => `    ${line}`).join('\n');
  return {
    id: 'banking', title: 'AI adoption in Dutch businesses · the banking question',
    summary: 'Follow a real CBS comparison from a broad banking question to two calculated figures and a qualified article.',
    question: 'How is AI adoption changing Dutch businesses, and what could that mean for banks such as ABN AMRO?',
    focusedQuestion: 'How does reported AI use differ by company size in CBS 2024, and how do turnover denominators and excluded microbusinesses limit banking interpretations?',
    stages: [
      { title: '01 · Explore the question', description: 'Begin with the broad banking question, then narrow it to a comparison the available evidence can answer: reported AI use by company size. This tutorial retains the prepared exploration. Adoption is observable here; productivity, loan performance and causality are not.' },
      { title: '02 · Gather evidence', description: 'Inspect the captured CBS tables and six-row dataset. The 2024 provisional estimates cover enterprises with at least ten persons employed in NACE C–N and Q. Separate the share of firms using AI from the share of turnover belonging to those firms. Banking commentary provides context, not additional compatible observations.' },
      { title: '03 · Analyze and challenge', description: 'Inspect genuine saved local Python results: a 41.4 percentage-point adoption gap and a 20.3-point difference between the largest group’s turnover and enterprise shares. Two figures expose why these are different questions. Saved outputs are labelled; an optional approved rerun computes new outputs from the captured CSV.' },
      { title: '04 · Draft', description: 'Read and edit the saved cited article with its actual figures and corrected interpretation. The draft says that AI use rises with company size within the surveyed population; it does not say AI caused revenue or that under-ten businesses have no adoption. Writing is prepared editorial work, separately attributed from execution.' },
    ],
    sources: [
      { title: 'CBS · Dutch AI monitor 2024, chapter 2', url: cbsUrl, content: 'Published 18 June 2025; captured 23 September 2026. Tables 2.1.3 and 2.2.1 supply the six compatible 2024 company-size groups used here. These are provisional aggregate estimates for enterprises with 10+ persons employed in NACE C–N and Q. Published confidence-interval endpoints are retained; no firm-level sample or new uncertainty estimate is invented. Source table text was captured by web browsing after direct retrieval returned HTTP 500, then deterministically extracted and joined by size label. This CSV is derived from published tables, not an original publisher CSV.' },
      { title: 'ABN AMRO Insights · digital-risk preparedness', url: 'https://www.abnamro.nl/nl/zakelijk/insights/sectoren-en-trends/alle-sectoren/mkb-niet-klaar-voor-nieuwe-digitale-risicos.html', content: 'Julia Krauwer, 23 June 2026. Prepared source summary: a separate ABN AMRO/MWM2 survey among 777 organisations motivates asking about digital-risk controls alongside AI use. Its sample, revenue-based classifications and questions differ from CBS. Its percentages are not joined to the calculated data, presented as a time trend or treated as client-level banking outcomes.' },
      { title: 'ABN AMRO Insights · retailer implementation questions', url: 'https://www.abnamro.nl/nl/zakelijk/insights/sectoren-en-trends/retail/ai-opent-deuren-maar-bezorgt-retailers-kopzorgen-over-kennis.html', content: 'Henk Hofstede and Ward van der Stee, 21 September 2023. Prepared source summary: a Q&A Insights Consultancy survey of 73 retailers discusses expected applications and knowledge constraints. This is narrower sector context, not nationwide adoption evidence. No percentage from this source enters the calculations, and no bank endorsement is implied.' },
    ],
    dataset: { title: 'CBS AI adoption and turnover by company size · 2024', csv: readExample('dutch-ai-adoption/cbs-ai-size-2024.csv'), provenance: 'Statistics Netherlands (CBS), Dutch AI monitor 2024, tables 2.1.3 and 2.2.1. Published 2025-06-18; public table text captured 2026-09-23 and converted to this six-row CSV. No microdata, imputation or invented sample counts. Source: ' + cbsUrl },
    analysis: { title: 'Calculate adoption and challenge the denominator', request: 'Recompute both reviewed CBS analyses from the captured six-row CSV in local Docker Python. Save the adoption figure, denominator challenge, metric/table outputs and qualified conclusions. This is a new local calculation only if explicitly approved; no inference or external search is requested.', code: combinedCode, parameters: {} },
    reference: {
      findings: '# Saved findings · actual local calculations\n\nThe two original Docker runs on 23 September 2026 computed a **41.4 percentage-point** gap: 59.2% of the 500+ group reports AI use versus 17.8% of the 10–19 group. In the 500+ group, AI-using firms account for 79.5% of turnover, **20.3 points** above their share of enterprises. Two intermediate size bins have turnover shares slightly below enterprise shares.\n\nThe challenge changes the draft: turnover belonging to adopters is not revenue caused by AI. Under-ten businesses are excluded, not zero adopters. These estimates establish neither productivity nor causality. The linked metrics, tables, plots and conclusions are genuine saved outputs; importing them runs no code.',
      draft: readExample('dutch-ai-adoption/article.md'),
      provenance: 'Prepared editorial article and actual saved local Docker outputs, 2026-09-23. No application-model or Tavily request created this banking example. Original run IDs, output hashes and capture times accompany each imported execution output.',
      outputs: savedOutputs('banking'),
    },
    draftGuide: 'Lead with the measurable finding, identify the covered population, separate enterprise and turnover denominators, then frame practical banking questions as hypotheses. Link the exact plots and sources. Distinguish saved preparation, manual edits and any separately authorized model refinement. No private writing guide is copied into this tutorial.',
    draftNarrative: '# AI adoption by business size: what the evidence supports\n\nThis draft describes a captured CBS comparison of six company-size groups, then challenges its interpretation using turnover shares. Insert the actual calculation results and figures with their execution provenance. Explain that an adoption indicator does not measure productivity, profitability or causal effects. Discuss banking applications as questions for client-specific evidence.\n\nSource: ' + cbsUrl,
    publicDataReady: true,
    publicDataStatus: 'Attributed public CBS aggregate statistics and prepared source summaries. No private account data, conversations, microdata or private writing guide is included. Public hosting still requires a deployment decision and an appropriate server boundary.',
  };
}

function market(): TutorialScenarioContent {
  return {
    id: 'market', title: 'When market conditions change · a historical risk baseline',
    summary: 'Compare two prior-loss windows on real historical prices, inspect the actual plots, and challenge what an overall breach rate means. Local research; redistribution remains restricted.',
    question: 'How well does a simple historical risk baseline describe losses as market conditions change?',
    focusedQuestion: 'How do 252- and 126-session historical loss thresholds behave on the same 755 S&P 500 evaluation sessions, and what does the aggregate rate leave unresolved?',
    stages: [
      { title: '01 · Explore the question', description: 'Start with changing market conditions, then make the question testable: compare one declared 252-session baseline with a 126-session sensitivity on identical observations. This is a retrospective comparison after the original baseline was known, not a preregistered holdout or a search for a winning strategy.' },
      { title: '02 · Gather evidence', description: 'Inspect the real FRED S&P 500 price-index capture and the selected RBA/Federal Reserve methodological sources. Prices exclude dividends; blank observations are omitted rather than filled. The full warm-up period precedes evaluation. S&P reproduction restrictions remain unresolved, so this scenario and its figures are local research only.' },
      { title: '03 · Analyze and challenge', description: 'Read the actual saved local computation: 31/755 breaches for the 252-session threshold and 38/755 for the 126-session sensitivity. Open yearly and timing plots, exact denominators and prior-information checks. The original model proposal filtered history too early; review restored full warm-up before execution. An optional rerun uses the corrected code.' },
      { title: '04 · Draft', description: 'Read and edit the saved research paper with its evidence, method, results and limits. The same overall percentage can conceal differences between periods. Neither window is declared superior or calibrated for the future. Original search, model proposal/interpretation, code review, actual calculation and prepared writing remain distinct.' },
    ],
    sources: [
      { title: 'S&P 500 [SP500] · S&P Dow Jones Indices via FRED', url: fredUrl, content: 'Captured 23 September 2026 for 2018–2021. Daily closing price-index levels in index points, not total returns or adjusted ETF prices. The capture has 1,044 weekday rows, 1,008 prices and 36 blanks; blank prices are omitted, never forward-filled. The full input history is retained before rolling windows. Series notes require prior permission for reproduction: access through FRED is not a public redistribution license. This tutorial remains local research.' },
      { title: 'RBA · Value-at-risk and backtesting techniques', url: 'https://www.rba.gov.au/publications/rdp/1997/9708/value-at-risk.html', content: 'Cassidy and Gizycki, November 1997, RDP 9708, section 2.4. Prepared attributed summary: historical simulation uses an empirical distribution of historical price changes instead of imposing normality. This motivates a transparent empirical-quantile baseline. The tutorial computes a percentage loss on one index, not a full bank portfolio valuation or current supervisory requirement.' },
      { title: 'Federal Reserve · The Hidden Dangers of Historical Simulation', url: 'https://www.federalreserve.gov/econres/feds/the-hidden-dangers-of-historical-simulation.htm', content: 'Matthew Pritsker, July 2001. Prepared attributed summary: the research discusses responsiveness to changing conditional risk and historical sample length. It motivates inspecting breach timing and a declared window sensitivity instead of judging one overall percentage. The paper studies methods beyond this one-index, one-day 95% example and does not certify its results or represent an institutional endorsement.' },
      { title: 'FRED · Citation and reuse guidance', url: 'https://fredhelp.stlouisfed.org/fred/graphs/share-my-fred-graph/cite/', content: 'FRED directs users to original-provider restrictions as well as suggested attribution. A source link and downloadable CSV do not establish permission to redistribute copyrighted data or derived figures. No public release of this market snapshot or its figures is authorized by the tutorial.' },
    ],
    dataset: { title: 'S&P 500 observed prices · 2018–2021 · local research', csv: readExample('demo-market-risk/source/fred-sp500-2018-2021.csv'), provenance: 'S&P Dow Jones Indices LLC, S&P 500 [SP500], via FRED. Captured 2026-09-23 from https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500&cosd=2018-01-01&coed=2021-12-31 . Unmodified capture: 1,044 weekday rows, 1,008 nonmissing prices, 36 blanks. Price index excludes dividends. No public redistribution permission obtained; keep data and derived figures local.' },
    analysis: { title: 'Compare two prior-loss windows', request: 'Recompute the reviewed 126- versus 252-session historical-loss sensitivity on the same 755 evaluation observations using captured real prices. Keep full warm-up before evaluation, save exact yearly/quarter counts, figures and no-look-ahead checks. This is a new local Docker calculation only if explicitly approved; no new inference, search or remote execution is requested.', code: readExample('demo-market-risk/research-v2/sensitivity.py'), parameters: {} },
    reference: {
      findings: '# Saved findings · actual local sensitivity\n\nThe corrected program used **755 identical evaluation sessions**. The 252-session baseline recorded **31 breaches (4.11%)** and the 126-session sensitivity **38 (5.03%)**. Yearly baseline counts were 4/250, 21/253 and 6/252; short-window counts were 9/250, 17/253 and 12/252. In 2020 Q1 the baseline had 16/62 breaches and the shorter window 14/62.\n\nThese are descriptive results, not evidence of future calibration or an optimized winner. The actual model proposal had a warm-up error: it filtered to evaluation dates before calculating thresholds. Review corrected the code before the saved Docker execution. Both thresholds use strictly preceding losses. Importing these genuine saved outputs does not perform another model call or calculation.',
      draft: readExample('demo-market-risk/research-v2/paper.md'),
      provenance: 'Original research on 2026-09-23 included two actual Tavily searches, two Nemotron Ultra inference requests, reviewed/corrected code and one actual local Docker sensitivity run. This tutorial reuses its saved calculation outputs and prepared paper; it performs none of those external calls merely by opening. Original output IDs, run IDs, timestamps and hashes are preserved in the imported provenance.',
      outputs: savedOutputs('market'),
    },
    draftGuide: 'State the exact common evaluation dates and denominators; distinguish the retrospective sensitivity from independent validation. Explain the full warm-up correction and prior-information rule. Report period differences without claiming causality, future calibration, an investment recommendation or a superior window. Preserve citation and reproduction limits.',
    draftNarrative: '# Historical loss thresholds under changing conditions\n\nThis study compares two declared prior-observation windows on the same captured price series. Insert actual execution metrics and figures, then examine yearly and quarterly differences before interpreting any overall rate. Thresholds exclude the current observation and use full warm-up history. The comparison is retrospective and descriptive; it does not establish future calibration or identify a trading strategy.\n\nPrice-index data exclude dividends and cover one market. The captured S&P series and derived figures remain local research because reproduction permission is unresolved. Source: ' + fredUrl,
    publicDataReady: false,
    publicDataStatus: 'Blocked for public redistribution: S&P/FRED series notes require prior reproduction permission; none was obtained for this captured CSV or derived figures. The original real-data scenario remains available locally. Public deployment needs permission or an explicitly chosen replacement dataset, plus an actual backend host.',
  };
}

// Loading stays on the server. The API decides which stage and saved outputs to
// reveal; importing this module never opens the original private project store.
export function loadTutorialContent(id: TutorialScenarioId): TutorialScenarioContent {
  return id === 'banking' ? banking() : market();
}
