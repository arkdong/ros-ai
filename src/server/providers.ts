import type { ModelMessage } from '../shared/types.js';
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
export type SearchResponse = { results:SearchResult[]; credits:number|null; requestId:string|null };
export type ExtractResponse = { pages:{url:string;content:string;locator:string}[]; failed:string[]; credits:number|null; requestId:string|null };
/** Basic search costs 1 credit and returns each page's summary; advanced costs 2 and returns the passages that best match the query. */
export type SearchDepth = 'basic'|'advanced';
export interface SearchAdapter {
  readonly configured:boolean;
  search(query:string,signal:AbortSignal,depth?:SearchDepth):Promise<SearchResponse>;
  /** The full text of pages a search found. */
  extract?(urls:string[],signal:AbortSignal):Promise<ExtractResponse>;
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

// Verified by an authenticated, read-only catalog GET on 2026-09-21. Rechecked
// before every inference; a historical NEBIUS_MODEL setting is not a selection.
export const DEFAULT_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const NEBIUS_BASE = 'https://api.tokenfactory.us-central1.nebius.com/v1';
// A Tavily-compatible gateway the person set up themselves can replace the public endpoint.
const TAVILY_BASE = process.env.TAVILY_BASE_URL?.replace(/\/+$/u, '') || 'https://api.tavily.com';

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
  if (wireRequest.model!==DEFAULT_MODEL || Object.keys(wireRequest).some(key=>!allowedKeys.includes(key)) || wireRequest.n!==1 || !Number.isInteger(wireRequest.max_completion_tokens) || Number(wireRequest.max_completion_tokens)<1 || !Array.isArray(messages) || !messages.length || !messages.every(message=>message&&typeof message==='object'&&['system','user','assistant'].includes(message.role)&&typeof message.content==='string'&&Object.keys(message).every(key=>key==='role'||key==='content'))) return null;
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
      const raw=body?.error?.message ?? (typeof body?.detail==='string'?body.detail:undefined);
      const credential=new Headers(init.headers).get('Authorization')?.replace(/^Bearer\s+/i,'');
      let message=typeof raw==='string'?raw:'';
      if(credential)message=message.split(credential).join('[redacted]');
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
    return this.model===DEFAULT_MODEL ? byteLevelTextInputBound(wireRequest) : null;
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

export const TAVILY_CREDIT_USD = 0.008;
export const SEARCH_SCHEMA = {name:'tavily_search',description:'One user-enabled basic web search. Captured search snippets, not full documents.',parameters:{type:'object',properties:{query:{type:'string',maxLength:400}},required:['query'],additionalProperties:false},configuration:{search_depth:'basic',max_results:3,auto_parameters:false,include_answer:false,include_raw_content:false,include_usage:true}};
// Checking a claim needs the page's own words: advanced search returns up to three verbatim passages per page.
export const CHECK_SEARCH_SCHEMA = {...SEARCH_SCHEMA,description:'One user-approved advanced web search for checking a claim. Captured passages of each page, not full documents.',configuration:{...SEARCH_SCHEMA.configuration,search_depth:'advanced',chunks_per_source:3}};
export const SEARCH_CREDITS:Record<SearchDepth,number> = {basic:1,advanced:2};
// Basic extract costs 1 credit for every 5 pages read. A page keeps at most PAGE_CHARACTERS.
export const EXTRACT_PAGES_PER_CREDIT = 5, PAGE_CHARACTERS = 50_000;
export const EXTRACT_SCHEMA = {name:'tavily_extract',description:'Read the full text of up to five pages an agent\'s searches found.',configuration:{extract_depth:'basic',format:'text',include_images:false,include_usage:true}};
export class TavilyAdapter implements SearchAdapter {
  get configured():boolean { return Boolean(this.key ?? process.env.TAVILY_API_KEY); }
  constructor(private readonly key?:string) {}
  async extract(urls:string[],signal:AbortSignal):Promise<ExtractResponse> {
    const result = await requestJson(`${TAVILY_BASE}/extract`,{method:'POST',headers:{Authorization:`Bearer ${this.credential()}`,'Content-Type':'application/json'},body:JSON.stringify({urls,...EXTRACT_SCHEMA.configuration}),signal});
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid page text.');
    // A page can come back under a slightly different address (a trailing slash, www.); it keeps the one asked for.
    const same = (url:string) => url.replace(/^https?:\/\/(?:www\.)?/u,'').replace(/\/+$/u,'');
    const pages = result.results.flatMap((page:any)=>{
      const url = typeof page.url === 'string' ? urls.find(asked=>same(asked)===same(page.url)) : undefined;
      if (!url || typeof page.raw_content !== 'string') return [];
      const content = page.raw_content.slice(0,PAGE_CHARACTERS);
      return [{url,content,locator:`Tavily extract; page text characters 0–${content.length}${page.raw_content.length > content.length ? ` of ${page.raw_content.length} (truncated)` : ''}`}];
    });
    const failed = urls.filter(url=>!pages.some((page:{url:string})=>page.url===url));
    return {pages,failed,credits:Number.isFinite(result.usage?.credits) && result.usage.credits >= 0 ? result.usage.credits : null,requestId:typeof result.request_id === 'string' ? result.request_id : null};
  }
  private credential():string {
    if (!this.configured) throw new Error('Set TAVILY_API_KEY in the server-side .env.local, then restart; model-only work is available without search.');
    return this.key ?? process.env.TAVILY_API_KEY ?? '';
  }
  async search(query:string,signal:AbortSignal,depth:SearchDepth='basic'):Promise<SearchResponse> {
    const key = this.credential(), configuration = depth === 'advanced' ? CHECK_SEARCH_SCHEMA.configuration : SEARCH_SCHEMA.configuration;
    const result = await requestJson(`${TAVILY_BASE}/search`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({query,...configuration}),signal});
    if (!Array.isArray(result.results)) throw new Error('Search provider returned invalid results.');
    return {results:result.results.slice(0,3).map((source:any,index:number)=>{
      if (typeof source.content !== 'string' || typeof source.url !== 'string') throw new Error('Search provider returned a malformed source.');
      const url = new URL(source.url);
      if (!['http:','https:'].includes(url.protocol)) throw new Error('Search provider returned an unsupported source URL.');
      // Keep the exact text sent to the model; explicitly record its bounded snippet range.
      const content = source.content.slice(0,6000);
      return {title:String(source.title ?? url.hostname).slice(0,300),url:url.href,content,locator:`Tavily search result ${index+1}; content characters 0–${content.length}${source.content.length > content.length ? ` of ${source.content.length} (truncated)` : ''}`};
    }),credits:Number.isFinite(result.usage?.credits) && result.usage.credits >= 0 ? result.usage.credits : null,requestId:typeof result.request_id === 'string' ? result.request_id : null};
  }
}
