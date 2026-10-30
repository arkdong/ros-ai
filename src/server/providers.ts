import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ModelMessage } from '../shared/types.js';
import { DEFAULT_NEBIUS_MODEL, ULTRA_MODEL } from '../shared/model-settings.js';
import type { SearchProviderId } from '../shared/search.js';
import {captureChatCompletion} from './response-normalization.js';

export type ModelCapabilities = { structuredOutput:boolean; cancellation:'abort-request'; toolCalling:boolean; modelVersion:boolean };
export type ModelInfo = { id:string; contextTokens:number; inputUsdPerToken:number; outputUsdPerToken:number; capabilities:ModelCapabilities; metadata:Record<string,unknown> };
/** One function call a model asked for. ros.ai validates and runs it; the model never does. */
export type ToolCall = { id:string; name:string; arguments:string };
/** Plain messages, plus the assistant tool calls and tool results an agent loop sends back. */
export type ChatMessage = ModelMessage | { role:'assistant'; content:string; toolCalls:ToolCall[] } | { role:'tool'; toolCallId:string; content:string };
export type ModelTool = { name:string; description:string; parameters:Record<string,unknown> };
export type ModelRequest = { messages:ChatMessage[]; maxOutputTokens:number; schema?:Record<string,unknown>; responseName?:string; responseMode?:'text-json'; tools?:ModelTool[] };
export type ModelResponse = { content:string; model:string; modelVersion:string|null; usage:{inputTokens:number;outputTokens:number}|null; metadata:Record<string,unknown>; toolCalls?:ToolCall[] };
export type ModelInputTokenBound = { tokens:number; basis:string };
export interface ModelAdapter {
  readonly provider:string;
  readonly model:string;
  readonly configured:boolean;
  prepare(signal:AbortSignal):Promise<ModelInfo>;
  describeRequest?(request:ModelRequest):Record<string,unknown>;
  inputTokenBound?(wireRequest:Record<string,unknown>):ModelInputTokenBound|null;
  complete(request:ModelRequest,signal:AbortSignal):Promise<ModelResponse>;
}
export type SearchResult = { title:string; url:string; content:string; locator:string };
/** credits: Tavily's own unit. costUsd: the dollars a service reported (Exa) or charges at a flat price (Brave). */
export type SearchResponse = { results:SearchResult[]; credits:number|null; requestId:string|null; costUsd?:number|null };
export type ExtractResponse = { pages:{url:string;content:string;locator:string}[]; failed:string[]; credits:number|null; requestId:string|null; costUsd?:number|null };
/** Basic search costs 1 credit and returns each page's summary; advanced costs 2 and returns the passages that best match the query. */
export type SearchDepth = 'basic'|'advanced';
/** A source of a Web block's sweep: its relevance to the query (0 to 1) and its site's icon, when the service gives them. */
export type SweepResult = SearchResult & { score:number|null; favicon:string|null };
export type SweepResponse = { results:SweepResult[]; credits:number|null; requestId:string|null; costUsd?:number|null };
export interface SearchAdapter {
  /** It can search: with a key, or on the service's free allowance. */
  readonly configured:boolean;
  /** It searches with no key, on the allowance the service gives anyone, and charges nothing. */
  readonly free?:boolean;
  search(query:string,signal:AbortSignal,depth?:SearchDepth):Promise<SearchResponse>;
  /** The full text of pages a search found. */
  extract?(urls:string[],signal:AbortSignal):Promise<ExtractResponse>;
  /** One search of a Web block's sweep, which keeps more sources of each search and draws them by relevance. */
  sweep?(query:string,signal:AbortSignal):Promise<SweepResponse>;
}

// Complete external harnesses are intentionally a different boundary from inference.
// A complete external harness remains separate from the bounded local experiment tool.
export type RuntimeCapabilities = { available:boolean; cancellation:boolean; modelVisibleInputs:boolean; toolTrace:boolean; generatedCode:boolean };
export type RuntimeEvent =
 | {type:'progress';message:string}
 | {type:'output';content:string;provenance:Record<string,unknown>|null}
 | {type:'error';message:string}
 | {type:'cancelled'};
export interface AgentRuntime {
  readonly id:string;
  readonly capabilities:RuntimeCapabilities;
  run(input:{request:string;materials:{content:string;reference:string}[]}, signal:AbortSignal):AsyncIterable<RuntimeEvent>;
}
export class DeferredAgentRuntime implements AgentRuntime {
  readonly capabilities:RuntimeCapabilities = {available:false,cancellation:false,modelVisibleInputs:false,toolTrace:false,generatedCode:false};
  constructor(readonly id:'codex'|'deepseek') {}
  async *run(_input:{request:string;materials:{content:string;reference:string}[]},_signal:AbortSignal):AsyncIterable<RuntimeEvent> {
    yield {type:'error',message:`${this.id} runtime integration is deferred. No external harness was invoked.`};
  }
}

/** The OpenAI chat-completions shape that Token Factory, Ollama and LM Studio all accept. */
export function wireMessages(messages:ChatMessage[]):Record<string,unknown>[] {
  return messages.map(message=>message.role==='tool'?{role:'tool',tool_call_id:message.toolCallId,content:message.content}
    :'toolCalls' in message&&message.toolCalls.length?{role:'assistant',content:message.content||null,tool_calls:message.toolCalls.map(call=>({id:call.id,type:'function',function:{name:call.name,arguments:call.arguments}}))}
    :{role:message.role,content:message.content});
}
export function wireTools(tools:ModelTool[]):Record<string,unknown>[] {
  return tools.map(item=>({type:'function',function:{name:item.name,description:item.description,parameters:item.parameters}}));
}

// The project default with a person's own Nebius key is Nemotron 3 Super (shared/model-settings.ts lists the
// models offered). The catalogue is rechecked before every inference; ROS_NEBIUS_MODEL still overrides the default.
export const DEFAULT_MODEL = DEFAULT_NEBIUS_MODEL;
export const NEBIUS_BASE = 'https://api.tokenfactory.us-central1.nebius.com/v1';
// A Tavily-compatible gateway the person set up themselves can replace the public endpoint.
const tavilyBase = () => process.env.TAVILY_BASE_URL?.replace(/\/+$/u, '') || 'https://api.tavily.com';
// Tavily answers searches and page reads with no key, within an allowance it gives anyone, when a request asks for its
// keyless mode (as Tavily's own MCP server does without a key). One id for each run of ros.ai lets it count that allowance.
const TAVILY_SESSION = randomUUID();

/** Audited scalar-text shape only. NVIDIA Ultra's published tokenizer is
 * byte-level BPE with no normalizer: merging cannot add tokens beyond UTF-8
 * bytes. The exact wire body includes ros.ai's injected schema instructions.
 * 16K fixed + 128/message covers the inspected 10,152-byte chat template's
 * markers and generation prefix. Native schema/tool and unknown shapes fall
 * back to full model context. Source audit: 2026-10-01, evidence/token-reservation-2026-10-01.json.
 */
export function byteLevelTextInputBound(wireRequest:Record<string,unknown>):ModelInputTokenBound|null {
  const messages=wireRequest.messages;
  const allowedKeys=['model','messages','max_completion_tokens','n','temperature'];
  if (wireRequest.model!==ULTRA_MODEL || Object.keys(wireRequest).some(key=>!allowedKeys.includes(key)) || wireRequest.n!==1 || !Number.isInteger(wireRequest.max_completion_tokens) || Number(wireRequest.max_completion_tokens)<1 || !Array.isArray(messages) || !messages.length || !messages.every(message=>message&&typeof message==='object'&&['system','user','assistant'].includes(message.role)&&typeof message.content==='string'&&Object.keys(message).every(key=>key==='role'||key==='content'))) return null;
  const bytes=Buffer.byteLength(JSON.stringify(wireRequest),'utf8');
  return {tokens:bytes+16384+128*messages.length,basis:`${bytes} exact wire UTF-8 bytes + 16,384 fixed chat-template tokens + 128 × ${messages.length} messages; audited Ultra byte-level BPE without normalization, scalar text only`};
}

function boundedNumber(value:unknown,name:string):number {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error(`Provider ${name} unavailable; no paid request was admitted.`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Provider ${name} unavailable; no paid request was admitted.`);
  return n;
}
async function requestJson(url:string,init:RequestInit):Promise<any> {
  let response:Response;
  try { response = await fetch(url,{...init,redirect:'error'}); }
  catch (error) {
    if (init.signal?.aborted) throw new Error('Request stopped; provider billing outcome may be unknown.');
    throw new Error('Provider connection failed; check connectivity. No automatic retry was attempted.');
  }
  // Retain a bounded diagnostic only, never the full body or headers. Redact the
  // exact outgoing credential and token-like values before an error can be logged.
  if (!response.ok) {
    let diagnostic='';
    try {
      const body=await response.json();
      const candidate=body?.error?.param;
      const field=['model','messages','tools','tool_choice','response_format','reasoning_effort','max_tokens','max_completion_tokens','temperature'].includes(candidate)?candidate:undefined;
      // Exa sends its error as a string; Brave Search puts it under error.detail.
      const raw=body?.error?.message ?? (typeof body?.error==='string'?body.error:undefined) ?? (typeof body?.error?.detail==='string'?body.error.detail:undefined) ?? (typeof body?.detail==='string'?body.detail:undefined);
      const headers=new Headers(init.headers);
      const credentials=[headers.get('Authorization')?.replace(/^Bearer\s+/i,''),headers.get('x-api-key'),headers.get('x-subscription-token')].filter((value):value is string=>Boolean(value));
      let message=typeof raw==='string'?raw:'';
      for(const credential of credentials)message=message.split(credential).join('[redacted]');
      message=message.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/[A-Za-z0-9_=-]{32,}/g,'[redacted]').replace(/[\r\n\x00-\x1f]+/g,' ').slice(0,240);
      const code=typeof body?.error?.code==='string'&&/^[a-z_]{1,40}$/.test(body.error.code)?body.error.code:'';
      diagnostic=[field?`field ${field}`:'',code,message].filter(Boolean).join('; ');
    } catch { /* Generic status remains useful for non-JSON errors. */ }
    throw new Error(`Provider returned HTTP ${response.status}${diagnostic?`: ${diagnostic}`:''}. Check account limits and model compatibility. No automatic retry was attempted.`);
  }
  try { return await response.json(); } catch { throw new Error('Provider returned an invalid response.'); }
}

export class NebiusAdapter implements ModelAdapter {
  readonly provider = 'nebius';
  get configured():boolean { return Boolean(this.key ?? process.env.NEBIUS_API_KEY); }
  private activeKey = '';
  private info?:ModelInfo;
  constructor(private readonly key?:string,readonly model = process.env.ROS_NEBIUS_MODEL ?? DEFAULT_MODEL) {}
  inputTokenBound(wireRequest:Record<string,unknown>):ModelInputTokenBound|null {
    return this.model===ULTRA_MODEL ? byteLevelTextInputBound(wireRequest) : null;
  }
  async prepare(signal:AbortSignal):Promise<ModelInfo> {
    this.info = undefined;
    this.activeKey = this.key ?? process.env.NEBIUS_API_KEY ?? '';
    if (!this.configured) throw new Error('Set NEBIUS_API_KEY in the server-side .env.local, then restart ros.ai. Canvas and history remain available.');
    const result = await requestJson(`${NEBIUS_BASE}/models?verbose=true`,{headers:{Authorization:`Bearer ${this.activeKey}`},signal});
    const model = result.data?.find((item:any)=>item.id === this.model);
    if (!model) throw new Error('The selected model is absent from the authenticated us-central1 catalog. No alternate model was selected.');
    const features:string[] = model.supported_features ?? [];
    const contextTokens = boundedNumber(model.context_length,'context length');
    if (!Number.isInteger(contextTokens) || contextTokens < 1) throw new Error('Provider context limit unavailable.');
    const inputUsdPerToken = boundedNumber(model.pricing?.prompt,'input price');
    const outputUsdPerToken = boundedNumber(model.pricing?.completion,'output price');
    // This implementation admits token-priced text requests only.
    for (const field of ['request','image','price_per_video_second','price_per_minute']) {
      if (model.pricing?.[field] !== undefined && boundedNumber(model.pricing[field],field) !== 0) throw new Error('Model has unsupported non-token pricing.');
    }
    this.info = {id:model.id,contextTokens,inputUsdPerToken,outputUsdPerToken,
      capabilities:{structuredOutput:features.includes('structured_outputs'),toolCalling:features.includes('tools'),cancellation:'abort-request',modelVersion:false},
      metadata:{catalogCheckedAt:new Date().toISOString(),endpoint:NEBIUS_BASE,contextTokens,pricing:model.pricing,supportedFeatures:features,quantization:model.quantization ?? null,modelVersion:'unavailable',billing:'Published catalog rates; account invoice and balance not available'}};
    return structuredClone(this.info);
  }
  describeRequest(request:ModelRequest):Record<string,unknown> {
    if (!this.info) throw new Error('Model catalog must be validated before inference.');
    if(request.tools){
      if(!this.info.capabilities.toolCalling)throw new Error('The selected model does not declare tool calling in the Token Factory catalog. Choose another model for the agent.');
      return {model:this.model,messages:wireMessages(request.messages),max_completion_tokens:request.maxOutputTokens,n:1,temperature:0.3,tools:wireTools(request.tools),tool_choice:'auto'};
    }
    if(request.responseMode==='text-json') return {model:this.model,messages:[{role:'system',content:`Return one JSON object matching this response contract. No Markdown fences or surrounding prose. This is a proposal only, never execution or permission. JSON Schema: ${JSON.stringify(request.schema)}`},...request.messages],max_completion_tokens:request.maxOutputTokens,n:1,temperature:0.3};
    if (request.schema && !this.info.capabilities.structuredOutput && !this.info.capabilities.toolCalling) throw new Error('Selected model declares neither structured output nor tool calling.');
    const toolMode = Boolean(request.schema && !this.info.capabilities.structuredOutput);
    const responseName = request.responseName ?? 'ros_ai_response';
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(responseName)) throw new Error('Invalid response contract name.');
    return {model:this.model,messages:request.messages,max_completion_tokens:request.maxOutputTokens,n:1,temperature:0.3,
      ...(request.schema ? toolMode ? {tools:[{type:'function',function:{name:responseName,description:'Return the requested proposal. This records a proposal only and does not authorize or execute code or canvas edits.',parameters:request.schema}}],tool_choice:{type:'function',function:{name:responseName}}} : {response_format:{type:'json_schema',json_schema:{name:responseName,strict:true,schema:request.schema}}} : {})};
  }
  async complete(request:ModelRequest,signal:AbortSignal):Promise<ModelResponse> {
    const body=this.describeRequest(request);
    const toolMode=Boolean(!request.tools && request.schema && request.responseMode!=='text-json' && !this.info!.capabilities.structuredOutput);
    const responseName=request.responseName ?? 'ros_ai_response';
    const result = await requestJson(`${NEBIUS_BASE}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${this.activeKey}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    return captureChatCompletion(result,{provider:this.provider,requestedModel:this.model,modelVersion:false,requireExactModel:true,
      responseContract:request.tools?'agent-tool-calls':request.responseMode==='text-json'?'application-validated-json':toolMode?'function-call':request.schema?'json-schema':'text',wireRequest:body,...(request.tools?{allowToolCalls:true}:toolMode?{functionName:responseName}:{})});
  }
}

// A page can come back under a slightly different address (a trailing slash, www.); it keeps the one asked for.
const pageKey = (url:string) => url.replace(/^https?:\/\/(?:www\.)?/u,'').replace(/\/+$/u,'');
const samePage = (asked:string,returned:string) => pageKey(asked)===pageKey(returned);

export const TAVILY_CREDIT_USD = 0.008;
export const SEARCH_SCHEMA = {name:'tavily_search',description:'One user-enabled basic web search. Captured search snippets, not full documents.',parameters:{type:'object',properties:{query:{type:'string',maxLength:400}},required:['query'],additionalProperties:false},configuration:{search_depth:'basic',max_results:3,auto_parameters:false,include_answer:false,include_raw_content:false,include_usage:true}};
// Checking a claim needs the page's own words: advanced search returns up to three verbatim passages per page.
export const CHECK_SEARCH_SCHEMA = {...SEARCH_SCHEMA,description:'One user-approved advanced web search for checking a claim. Captured passages of each page, not full documents.',configuration:{...SEARCH_SCHEMA.configuration,search_depth:'advanced',chunks_per_source:3}};
export const SEARCH_CREDITS:Record<SearchDepth,number> = {basic:1,advanced:2};
// A Web block's sweep keeps five sources of each basic search, still 1 credit, with each site's icon.
export const SWEEP_SEARCH_SCHEMA = {...SEARCH_SCHEMA,description:'One basic web search of a Web block\'s sweep. Captured search snippets, not full documents.',configuration:{...SEARCH_SCHEMA.configuration,max_results:5,include_favicon:true}};
// Basic extract costs 1 credit for every 5 pages read. A page keeps at most PAGE_CHARACTERS.
export const EXTRACT_PAGES_PER_CREDIT = 5, PAGE_CHARACTERS = 50_000;
export const EXTRACT_SCHEMA = {name:'tavily_extract',description:'Read the full text of up to five pages an agent\'s searches found.',configuration:{extract_depth:'basic',format:'text',include_images:false,include_usage:true}};
export class TavilyAdapter implements SearchAdapter {
  get configured():boolean { return Boolean(this.key ?? process.env.TAVILY_API_KEY) || this.free; }
  /** With no key, the local app searches on Tavily's keyless allowance (options.free); it charges nothing. */
  get free():boolean { return this.options.free === true && !(this.key ?? process.env.TAVILY_API_KEY); }
  constructor(private readonly key?:string, private readonly options:{free?:boolean}={}) {}
  private async post(path:string,body:Record<string,unknown>,signal:AbortSignal):Promise<any> {
    const free=this.free;
    try {
      return await requestJson(`${tavilyBase()}${path}`,{method:'POST',headers:free?{'X-Tavily-Access-Mode':'keyless','X-Client-Source':'ros.ai','X-Session-Id':TAVILY_SESSION,'Content-Type':'application/json'}:{Authorization:`Bearer ${this.credential()}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    } catch (error) {
      // Tavily refuses keyless requests past its allowance (or asks for payment); a key of the person's own goes further.
      if (free && error instanceof Error && /^Provider returned HTTP (401|402|403|429)\b/u.test(error.message)) throw new Error(`Tavily’s free searches with no account are used up for now. Add a Tavily key under Plugins › Tavily web search › More to search more. (${error.message.replace(/\. Check account limits[\s\S]*$/u,'')}.)`);
      throw error;
    }
  }
  async extract(urls:string[],signal:AbortSignal):Promise<ExtractResponse> {
    const free=this.free,result = await this.post('/extract',{urls,...EXTRACT_SCHEMA.configuration},signal);
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid page text.');
    const pages = result.results.flatMap((page:any)=>{
      const url = typeof page.url === 'string' ? urls.find(asked=>samePage(asked,page.url)) : undefined;
      if (!url || typeof page.raw_content !== 'string') return [];
      const content = page.raw_content.slice(0,PAGE_CHARACTERS);
      return [{url,content,locator:`Tavily extract; page text characters 0–${content.length}${page.raw_content.length > content.length ? ` of ${page.raw_content.length} (truncated)` : ''}`}];
    });
    const failed = urls.filter(url=>!pages.some((page:{url:string})=>page.url===url));
    return {pages,failed,credits:Number.isFinite(result.usage?.credits) && result.usage.credits >= 0 ? result.usage.credits : null,requestId:typeof result.request_id === 'string' ? result.request_id : null,...(free?{costUsd:0}:{})};
  }
  private credential():string {
    if (!this.configured) throw new Error('Set TAVILY_API_KEY in the server-side .env.local, then restart; model-only work is available without search.');
    return this.key ?? process.env.TAVILY_API_KEY ?? '';
  }
  async search(query:string,signal:AbortSignal,depth:SearchDepth='basic'):Promise<SearchResponse> {
    const result = await this.request(query,depth === 'advanced' ? CHECK_SEARCH_SCHEMA.configuration : SEARCH_SCHEMA.configuration,signal);
    return {...result,results:result.results.slice(0,3).map(({score:_score,favicon:_favicon,...source})=>source)};
  }
  async sweep(query:string,signal:AbortSignal):Promise<SweepResponse> {
    return this.request(query,SWEEP_SEARCH_SCHEMA.configuration,signal);
  }
  private async request(query:string,configuration:Record<string,unknown>,signal:AbortSignal):Promise<SweepResponse> {
    const free=this.free,result = await this.post('/search',{query,...configuration},signal);
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid results.');
    return {results:result.results.slice(0,5).map((source:any,index:number)=>{
      if (typeof source.content !== 'string' || typeof source.url !== 'string') throw new Error('Search provider returned a malformed source.');
      const url = new URL(source.url);
      if (!['http:','https:'].includes(url.protocol)) throw new Error('Search provider returned an unsupported source URL.');
      // Keep the exact text sent to the model; explicitly record its bounded snippet range.
      const content = source.content.slice(0,6000);
      const score = typeof source.score === 'number' && Number.isFinite(source.score) ? Math.max(0,Math.min(1,source.score)) : null;
      // A site icon is only ever shown as an image, so only a web address is kept.
      const favicon = typeof source.favicon === 'string' && /^https:\/\/[^\s"'<>]{1,500}$/u.test(source.favicon) ? source.favicon : null;
      return {title:String(source.title || url.hostname).slice(0,300),url:url.href,content,locator:`Tavily search result ${index+1}; content characters 0–${content.length}${source.content.length > content.length ? ` of ${source.content.length} (truncated)` : ''}`,score,favicon};
    }),credits:Number.isFinite(result.usage?.credits) && result.usage.credits >= 0 ? result.usage.credits : null,requestId:typeof result.request_id === 'string' ? result.request_id : null,...(free?{costUsd:0}:{})};
  }
}

const usd = (value:unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const sourceUrl = (value:unknown) => {
  if (typeof value !== 'string') throw new Error('Search provider returned a malformed source.');
  const url = new URL(value);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('Search provider returned an unsupported source URL.');
  return url;
};
/** Passages of one page as one saved excerpt: the exact text the model sees, with its bounded range. */
const excerpt = (service:string,index:number,passages:string[]) => {
  const full = passages.map(passage=>passage.trim()).filter(Boolean).join('\n…\n'), content = full.slice(0,6000);
  return {content,locator:`${service} search result ${index+1}; passages characters 0–${content.length}${full.length > content.length ? ` of ${full.length} (truncated)` : ''}`};
};

// Exa finds pages by meaning and returns the passages of each that match the query. Search with
// contents is US$7 per 1,000 requests of up to 10 results; reading pages is US$1 per 1,000 pages.
// Exa reports each request's cost, which settles its reservation.
// EXA_BASE_URL and BRAVE_BASE_URL name a compatible gateway instead, read at each request.
const exaBase = () => process.env.EXA_BASE_URL?.replace(/\/+$/u, '') || 'https://api.exa.ai';
export const EXA_SEARCH_USD = 0.007, EXA_PAGE_USD = 0.001;
export const EXA_SEARCH_SCHEMA = {name:'exa_search',description:'One user-enabled Exa web search. Captured passages of each page, not full documents.',parameters:SEARCH_SCHEMA.parameters,configuration:{type:'auto',numResults:3,contents:{highlights:{maxCharacters:4000}}}};
export const EXA_CONTENTS_SCHEMA = {name:'exa_contents',description:'Read the full text of up to five pages an agent\'s searches found.',configuration:{text:{maxCharacters:PAGE_CHARACTERS}}};
// Exa's hosted MCP server searches and reads pages for anyone, within its limits, with no key (as Exa's README says);
// its web_search_exa and web_fetch_exa answer in text, read below. EXA_MCP_URL names a stand-in.
const exaMcpUrl = () => process.env.EXA_MCP_URL?.trim() || 'https://mcp.exa.ai/mcp';
const EXA_FREE_SPENT = 'Exa’s free searches with no account are used up for now. Add an Exa key under Plugins › Exa web search › More to search more.';
/** web_search_exa's answer: a block for each page, apart by a line of ---, with "Title:", "URL:", "Published:" and
 * "Author:" lines (N/A when unknown), then "Highlights:" and the passages that answer the search (or "Text:" and the
 * page's text). */
export function exaFreeResults(text:string):{title:string;url:string;passages:string}[] {
  return text.split(/\n+---\n+/u).flatMap(block=>{
    const url=/^URL: (\S+)[ \t]*$/mu.exec(block)?.[1];
    if (!url) return [];
    const passages=/^Highlights:\n([\s\S]*)$/mu.exec(block)?.[1] ?? /^Text: ([\s\S]*)$/mu.exec(block)?.[1] ?? '';
    const title=/^Title: (.*)$/mu.exec(block)?.[1]?.trim() ?? '';
    return [{title:title==='N/A'?'':title,url,passages:passages.trim()}];
  });
}
/** web_fetch_exa's answer: for each page "# <title>", "URL:", "Published:" and "Author:" when known, a blank line and
 * the page's text; then "Error fetching <address>: <reason>" for each page it could not read. */
export function exaFreePages(text:string):{url:string;text:string}[] {
  const heads=[...text.matchAll(/^# (.*)\nURL: (\S+)[ \t]*$/gmu)];
  return heads.map((head,index)=>{
    const body=text.slice(head.index!+head[0].length,index+1<heads.length?heads[index+1]!.index!:text.length);
    return {url:head[2]!,text:body.replace(/^\n(?:Published: .*\n)?(?:Author: .*\n)?/u,'').replace(/(?:\nError fetching .*)+\s*$/u,'').trim()};
  });
}
/** Exa's free search: one MCP session for each run of ros.ai, opened when first needed and again after it drops. */
class ExaFree {
  private session:Promise<Client>|null=null;
  private open():Promise<Client> {
    if (!this.session) {
      const client=new Client({name:'ros.ai',version:'1'}),session=client.connect(new StreamableHTTPClientTransport(new URL(exaMcpUrl()))).then(()=>client);
      this.session=session;
      session.catch(()=>{ if (this.session===session) this.session=null; });
    }
    return this.session;
  }
  async call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<string> {
    const stopped=()=>new Error('Request stopped; provider billing outcome may be unknown.');
    let client:Client;
    try { client=await this.open(); }
    catch { if (signal.aborted) throw stopped(); throw new Error('Could not reach Exa’s free search. Check the connection, or add an Exa key under Plugins › Exa web search › More.'); }
    let result:Awaited<ReturnType<Client['callTool']>>;
    try { result=await client.callTool({name,arguments:args},undefined,{signal,timeout:60_000}); }
    catch {
      // A dropped session opens again for the next search.
      if (this.session) { this.session=null; void client.close().catch(()=>undefined); }
      if (signal.aborted) throw stopped();
      throw new Error('Exa’s free search did not answer. Try again, or add an Exa key under Plugins › Exa web search › More.');
    }
    const text=(Array.isArray(result.content)?result.content as {type:string;text?:unknown}[]:[]).flatMap(item=>item.type==='text'&&typeof item.text==='string'?[item.text]:[]).join('\n');
    if (result.isError) throw new Error(/rate limit/iu.test(text)?EXA_FREE_SPENT:`Exa’s free search refused: ${text.replace(/[\r\n\x00-\x1f]+/gu,' ').slice(0,240)}`);
    return text;
  }
}
export class ExaAdapter implements SearchAdapter {
  get configured():boolean { return Boolean(this.key ?? process.env.EXA_API_KEY) || this.free; }
  /** With no key, the local app searches through Exa's hosted MCP server, free within its limits (options.free). */
  get free():boolean { return this.options.free === true && !(this.key ?? process.env.EXA_API_KEY); }
  private readonly hosted=new ExaFree();
  constructor(private readonly key?:string, private readonly options:{free?:boolean}={}) {}
  private headers() {
    const key=this.key ?? process.env.EXA_API_KEY;
    if (!key) throw new Error('Add an Exa key on the Plugins page; model-only work is available without search.');
    return {'x-api-key':key,'Content-Type':'application/json'};
  }
  async search(query:string,signal:AbortSignal):Promise<SearchResponse> {
    if (this.free) {
      const found=exaFreeResults(await this.hosted.call('web_search_exa',{query,numResults:EXA_SEARCH_SCHEMA.configuration.numResults},signal));
      const results=found.slice(0,3).flatMap((source,index)=>{
        const url=sourceUrl(source.url),saved=excerpt('Exa',index,[source.passages]);
        return saved.content?[{title:String(source.title || url.hostname).slice(0,300),url:url.href,...saved}]:[];
      });
      return {results,credits:null,requestId:null,costUsd:0};
    }
    const result = await requestJson(`${exaBase()}/search`,{method:'POST',headers:this.headers(),body:JSON.stringify({query,...EXA_SEARCH_SCHEMA.configuration}),signal});
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid results.');
    const results = result.results.slice(0,3).flatMap((source:any,index:number)=>{
      const url = sourceUrl(source.url);
      const passages = Array.isArray(source.highlights) ? source.highlights.filter((item:unknown):item is string=>typeof item === 'string') : typeof source.text === 'string' ? [source.text] : [];
      const saved = excerpt('Exa',index,passages);
      return saved.content ? [{title:String(source.title || url.hostname).slice(0,300),url:url.href,...saved}] : [];
    });
    return {results,credits:null,requestId:typeof result.requestId === 'string' ? result.requestId : null,costUsd:usd(result.costDollars?.total)};
  }
  async extract(urls:string[],signal:AbortSignal):Promise<ExtractResponse> {
    if (this.free) {
      const pages=exaFreePages(await this.hosted.call('web_fetch_exa',{urls,maxCharacters:PAGE_CHARACTERS},signal)).flatMap(page=>{
        const url=urls.find(asked=>samePage(asked,page.url));
        if (!url || !page.text) return [];
        const content=page.text.slice(0,PAGE_CHARACTERS);
        return [{url,content,locator:`Exa contents; page text characters 0–${content.length}${page.text.length > content.length ? ` of ${page.text.length} (truncated)` : ''}`}];
      });
      return {pages,failed:urls.filter(url=>!pages.some(page=>page.url===url)),credits:null,requestId:null,costUsd:0};
    }
    const result = await requestJson(`${exaBase()}/contents`,{method:'POST',headers:this.headers(),body:JSON.stringify({urls,...EXA_CONTENTS_SCHEMA.configuration}),signal});
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid page text.');
    const pages = result.results.flatMap((page:any)=>{
      const url = typeof page.url === 'string' ? urls.find(asked=>samePage(asked,page.url)) : undefined;
      if (!url || typeof page.text !== 'string' || !page.text.trim()) return [];
      const content = page.text.slice(0,PAGE_CHARACTERS);
      return [{url,content,locator:`Exa contents; page text characters 0–${content.length}${page.text.length > content.length ? ` of ${page.text.length} (truncated)` : ''}`}];
    });
    const failed = urls.filter(url=>!pages.some((page:{url:string})=>page.url===url));
    return {pages,failed,credits:null,requestId:typeof result.requestId === 'string' ? result.requestId : null,costUsd:usd(result.costDollars?.total)};
  }
}

// Brave Search answers from its own index of the web. Its LLM context endpoint returns the passages of
// each page that match the query. The Search plan charges US$5 per 1,000 requests and reports no cost
// per request, so each search settles at that flat price. It cannot read a whole page.
const braveBase = () => process.env.BRAVE_BASE_URL?.replace(/\/+$/u, '') || 'https://api.search.brave.com';
export const BRAVE_SEARCH_USD = 0.005;
export const BRAVE_SEARCH_SCHEMA = {name:'brave_llm_context',description:'One user-enabled Brave web search. Captured passages of each page, not full documents.',parameters:SEARCH_SCHEMA.parameters,configuration:{count:8,maximum_number_of_urls:3,maximum_number_of_tokens:4096,maximum_number_of_tokens_per_url:1536}};
export class BraveAdapter implements SearchAdapter {
  get configured():boolean { return Boolean(this.key ?? process.env.BRAVE_API_KEY); }
  constructor(private readonly key?:string) {}
  async search(query:string,signal:AbortSignal):Promise<SearchResponse> {
    if (!this.configured) throw new Error('Add a Brave Search key on the Plugins page; model-only work is available without search.');
    // Brave takes at most 50 words in a query.
    const params = new URLSearchParams({q:query.split(/\s+/u).slice(0,50).join(' '),...Object.fromEntries(Object.entries(BRAVE_SEARCH_SCHEMA.configuration).map(([name,value])=>[name,String(value)]))});
    const result = await requestJson(`${braveBase()}/res/v1/llm/context?${params}`,{method:'GET',headers:{Accept:'application/json','X-Subscription-Token':this.key ?? process.env.BRAVE_API_KEY ?? ''},signal});
    const items = result?.grounding?.generic;
    if (!Array.isArray(items)) throw new Error('Search provider returned invalid results.');
    const results = items.slice(0,3).flatMap((item:any,index:number)=>{
      const url = sourceUrl(item.url);
      const passages = Array.isArray(item.snippets) ? item.snippets.filter((snippet:unknown):snippet is string=>typeof snippet === 'string') : [];
      const saved = excerpt('Brave',index,passages), title = item.title || result.sources?.[item.url]?.title || url.hostname;
      return saved.content ? [{title:String(title).slice(0,300),url:url.href,...saved}] : [];
    });
    return {results,credits:null,requestId:null,costUsd:BRAVE_SEARCH_USD};
  }
}

/** What each search service is called and charges at most, for its reservations, the search plan a researcher
 * approves and the agent's tool descriptions. Tavily's wording is what the agent was trained on and stays as it was. */
export type SearchTool = {name:string;description:string;configuration:Record<string,unknown>};
export type SearchPricing = {
  label:string; searchUsd:number; searchBasis:string; model:string; schema:SearchTool & {parameters:Record<string,unknown>};
  /** Reading whole pages, for a service that can: the upper bound and basis of one batch, and how plans and tools state the price. */
  read?:{usd:(pages:number)=>number; basis:(pages:number)=>string; price:string; terms:string; model:string; schema:SearchTool};
};
export const SEARCH_SERVICES:Record<SearchProviderId,SearchPricing> = {
  tavily:{label:'Tavily',searchUsd:TAVILY_CREDIT_USD,searchBasis:'Continued cumulative Tavily allowance: one basic search, 1 credit at $0.008 PAYG upper bound.',model:'basic-search',schema:SEARCH_SCHEMA,
    read:{usd:pages=>Math.ceil(pages/EXTRACT_PAGES_PER_CREDIT)*TAVILY_CREDIT_USD,basis:pages=>`Continued cumulative Tavily allowance: basic extract of ${pages} page${pages===1?'':'s'}, ${Math.ceil(pages/EXTRACT_PAGES_PER_CREDIT)} credit at $0.008 PAYG upper bound.`,
      price:`US$${TAVILY_CREDIT_USD} for each ${EXTRACT_PAGES_PER_CREDIT} read together`,terms:`Tavily charges 1 credit, US$0.008, for each ${EXTRACT_PAGES_PER_CREDIT} pages read together`,model:'basic-extract',schema:EXTRACT_SCHEMA}},
  exa:{label:'Exa',searchUsd:EXA_SEARCH_USD,searchBasis:'Exa search with page passages: US$7 per 1,000 requests of up to 10 results, published rate; Exa reports the cost of each request.',model:'auto-search',schema:EXA_SEARCH_SCHEMA,
    read:{usd:pages=>pages*EXA_PAGE_USD,basis:pages=>`Exa contents: the text of ${pages} page${pages===1?'':'s'} at US$1 per 1,000 pages, published rate; Exa reports the cost of each request.`,
      price:`US$${EXA_PAGE_USD} each`,terms:`Exa charges US$${EXA_PAGE_USD} for each page`,model:'contents',schema:EXA_CONTENTS_SCHEMA}},
  brave:{label:'Brave Search',searchUsd:BRAVE_SEARCH_USD,searchBasis:'Brave Search plan: one LLM context request at US$5 per 1,000 requests, published flat rate.',model:'llm-context',schema:BRAVE_SEARCH_SCHEMA},
};
/** What one search or page reading cost: the dollars a service reported, or Tavily's credits at its price. */
export const searchCostUsd = (response:{credits:number|null;costUsd?:number|null}) => response.costUsd !== undefined ? response.costUsd : response.credits === null ? null : response.credits*TAVILY_CREDIT_USD;
