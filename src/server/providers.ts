import type { ModelMessage } from '../shared/types.js';

export type ModelCapabilities = { structuredOutput:boolean; cancellation:'abort-request'; toolCalling:boolean; modelVersion:boolean };
export type ModelInfo = { id:string; contextTokens:number; inputUsdPerToken:number; outputUsdPerToken:number; capabilities:ModelCapabilities; metadata:Record<string,unknown> };
export type ModelRequest = { messages:ModelMessage[]; maxOutputTokens:number; schema?:Record<string,unknown>; responseName?:string; responseMode?:'text-json' };
export type ModelResponse = { content:string; model:string; modelVersion:string|null; usage:{inputTokens:number;outputTokens:number}|null; metadata:Record<string,unknown> };
export interface ModelAdapter {
  readonly provider:string;
  readonly model:string;
  readonly configured:boolean;
  prepare(signal:AbortSignal):Promise<ModelInfo>;
  describeRequest?(request:ModelRequest):Record<string,unknown>;
  complete(request:ModelRequest,signal:AbortSignal):Promise<ModelResponse>;
}
export type SearchResult = { title:string; url:string; content:string; locator:string };
export type SearchResponse = { results:SearchResult[]; credits:number|null; requestId:string|null };
export interface SearchAdapter {
  readonly configured:boolean;
  search(query:string,signal:AbortSignal):Promise<SearchResponse>;
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

// Verified by an authenticated, read-only catalog GET on 2026-09-21. Rechecked
// before every inference; a historical NEBIUS_MODEL setting is not a selection.
export const DEFAULT_MODEL = 'nvidia/Nemotron-3-Ultra-550b-a55b';
export const NEBIUS_BASE = 'https://api.tokenfactory.us-central1.nebius.com/v1';
const TAVILY_BASE = 'https://api.tavily.com';

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
  readonly configured:boolean;
  private info?:ModelInfo;
  constructor(private readonly key = process.env.NEBIUS_API_KEY ?? '',readonly model = process.env.ROS_NEBIUS_MODEL ?? DEFAULT_MODEL) {
    this.configured = Boolean(key);
  }
  async prepare(signal:AbortSignal):Promise<ModelInfo> {
    this.info = undefined;
    if (!this.configured) throw new Error('Set NEBIUS_API_KEY in the server-side .env.local, then restart ros.ai. Canvas and history remain available.');
    const result = await requestJson(`${NEBIUS_BASE}/models?verbose=true`,{headers:{Authorization:`Bearer ${this.key}`},signal});
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
    if(request.responseMode==='text-json') return {model:this.model,messages:[{role:'system',content:`Return one JSON object matching this response contract. No Markdown fences or surrounding prose. This is a proposal only, never execution or permission. JSON Schema: ${JSON.stringify(request.schema)}`},...request.messages],max_tokens:request.maxOutputTokens,temperature:0.3};
    if (request.schema && !this.info.capabilities.structuredOutput && !this.info.capabilities.toolCalling) throw new Error('Selected model declares neither structured output nor tool calling.');
    const toolMode = Boolean(request.schema && !this.info.capabilities.structuredOutput);
    const responseName = request.responseName ?? 'ros_ai_response';
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(responseName)) throw new Error('Invalid response contract name.');
    return {model:this.model,messages:request.messages,max_tokens:request.maxOutputTokens,temperature:0.3,
      ...(request.schema ? toolMode ? {tools:[{type:'function',function:{name:responseName,description:'Return the requested proposal. This records a proposal only and does not authorize or execute code or canvas edits.',parameters:request.schema}}],tool_choice:{type:'function',function:{name:responseName}}} : {response_format:{type:'json_schema',json_schema:{name:responseName,strict:true,schema:request.schema}}} : {})};
  }
  async complete(request:ModelRequest,signal:AbortSignal):Promise<ModelResponse> {
    const body=this.describeRequest(request);
    const toolMode=Boolean(request.schema && request.responseMode!=='text-json' && !this.info!.capabilities.structuredOutput);
    const responseName=request.responseName ?? 'ros_ai_response';
    const result = await requestJson(`${NEBIUS_BASE}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
    if (typeof result.model==='string' && result.model!==this.model) throw new Error('Provider returned a different model than requested; no alternate result was accepted.');
    const message = result.choices?.[0]?.message;
    const calls = message?.tool_calls;
    if (toolMode && (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.type !== 'function' || calls[0]?.function?.name !== responseName || typeof calls[0]?.function?.arguments !== 'string')) throw new Error('Provider returned an unexpected tool request; nothing was authorized or executed.');
    if (!toolMode && calls?.length) throw new Error('Provider returned unsolicited tool requests; nothing was executed.');
    let content = toolMode ? calls[0].function.arguments : message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Provider returned no text response.');
    if (content.length > 100000) throw new Error('Provider response exceeds the bounded contract.');
    if(request.responseMode==='text-json'){
      content=content.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/,'$1').trim();
      try{const value=JSON.parse(content);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();}catch{throw new Error('Provider did not return a JSON object for the application-validated proposal. No action was executed.');}
    }
    if (toolMode) { try { JSON.parse(content); } catch { throw new Error('Provider returned invalid tool arguments; nothing was authorized or executed.'); } }
    const input = result.usage?.prompt_tokens, output = result.usage?.completion_tokens;
    const usage = Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0 ? {inputTokens:input,outputTokens:output} : null;
    return {content,model:result.model ?? this.model,modelVersion:null,usage,metadata:{requestId:result.id ?? null,finishReason:result.choices?.[0]?.finish_reason ?? null,systemFingerprint:result.system_fingerprint ?? null,providerUsage:result.usage ?? null,responseContract:request.responseMode==='text-json'?'application-validated-json':toolMode?'function-call':request.schema?'json-schema':'text',...(toolMode?{toolRequests:calls}:{}),wireRequest:body}};
  }
}

export const TAVILY_CREDIT_USD = 0.008;
export const SEARCH_SCHEMA = {name:'tavily_search',description:'One user-enabled basic web search. Captured search snippets, not full documents.',parameters:{type:'object',properties:{query:{type:'string',maxLength:400}},required:['query'],additionalProperties:false},configuration:{search_depth:'basic',max_results:3,auto_parameters:false,include_answer:false,include_raw_content:false,include_usage:true}};
export class TavilyAdapter implements SearchAdapter {
  readonly configured:boolean;
  constructor(private readonly key = process.env.TAVILY_API_KEY ?? '') { this.configured = Boolean(key); }
  async search(query:string,signal:AbortSignal):Promise<SearchResponse> {
    if (!this.configured) throw new Error('Set TAVILY_API_KEY in the server-side .env.local, then restart; model-only work is available without search.');
    const result = await requestJson(`${TAVILY_BASE}/search`,{method:'POST',headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json'},body:JSON.stringify({query,...SEARCH_SCHEMA.configuration}),signal});
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
