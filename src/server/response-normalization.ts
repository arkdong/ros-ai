import {z} from 'zod';
import type {ModelResponse} from './providers.js';
import {presentAssistantResponse,type AssistantResponsePresentation} from '../shared/assistant-presentation.js';

const CAPTURE_CHARACTERS=100000;
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const boundedString=(value:unknown,maximum:number):string|null=>typeof value==='string'?value.slice(0,maximum):null;
const finiteCount=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;

/** Capture only visible text and numeric usage details, never hidden reasoning.
 * Capture limits are separate from the application action contract. Successful
 * HTTP responses must reach the usage ledger before a consumer rejects them.
 */
export function captureChatCompletion(result:unknown,options:{provider:string;requestedModel:string;modelVersion:boolean;responseContract:string;wireRequest:Record<string,unknown>;functionName?:string;requireExactModel?:boolean}):ModelResponse {
  const envelope=record(result),choices=Array.isArray(envelope.choices)?envelope.choices:[],choice=record(choices[0]),message=record(choice.message);
  const visible=boundedString(message.content,CAPTURE_CHARACTERS)??'';
  const visibleLength=typeof message.content==='string'?message.content.length:null;
  const calls=message.tool_calls;
  const expectedCall=options.functionName&&Array.isArray(calls)&&calls.length===1&&record(calls[0]).type==='function'&&record(record(calls[0]).function).name===options.functionName&&typeof record(record(calls[0]).function).arguments==='string';
  const argumentsText=expectedCall?record(record((calls as unknown[])[0]).function).arguments as string:null;
  const rawContent=options.functionName?argumentsText:typeof message.content==='string'?message.content:null;
  const content=boundedString(rawContent,CAPTURE_CHARACTERS)??'';
  const reportedModel=boundedString(envelope.model,256),model=reportedModel??options.requestedModel;
  const usageRecord=record(envelope.usage),input=usageRecord.prompt_tokens,output=usageRecord.completion_tokens;
  const usage=finiteCount(input)&&finiteCount(output)?{inputTokens:input,outputTokens:output}:null;
  // Usage objects contain numeric counts; discard unrecognized strings/blobs.
  const numericUsage=(value:unknown,depth=0):Record<string,unknown>=>{
    const counts:Record<string,unknown>={};
    for(const [key,item] of Object.entries(record(value)).slice(0,32)){
      if(!/^[a-z][a-z0-9_]{0,63}$/i.test(key))continue;
      if(finiteCount(item))counts[key]=item;
      else if(depth<2&&item&&typeof item==='object'&&!Array.isArray(item))counts[key]=numericUsage(item,depth+1);
    }
    return counts;
  };
  let responseError:string|null=null;
  if(choices.length!==1)responseError='Provider returned an unexpected number of response choices. No proposed action was accepted.';
  else if(options.requireExactModel&&reportedModel!==null&&reportedModel!==options.requestedModel)responseError='Provider returned a different model than requested. No alternate result or proposed action was accepted.';
  else if(options.functionName&&!expectedCall)responseError='Provider returned an unexpected tool request. Nothing was authorized or executed.';
  else if(!options.functionName&&calls!==undefined&&calls!==null&&(!Array.isArray(calls)||calls.length>0))responseError='Provider returned unsolicited tool requests. Nothing was executed.';
  else if(rawContent===null||!rawContent.trim())responseError='Provider returned no text response. The response receipt and any reported usage remain saved.';
  else if(rawContent.length>CAPTURE_CHARACTERS)responseError='Provider response exceeds the bounded capture contract. Its bounded preview and reported usage remain saved; no proposed action was accepted.';
  return {content,model,modelVersion:options.modelVersion?reportedModel:null,usage,metadata:{
    provider:options.provider,requestId:boundedString(envelope.id,256),finishReason:boundedString(choice.finish_reason,80),systemFingerprint:boundedString(envelope.system_fingerprint,256),
    providerUsage:envelope.usage?numericUsage(envelope.usage):null,responseContract:options.responseContract,wireRequest:options.wireRequest,
    rawVisibleResponse:{content:visible,characters:visibleLength,truncated:visibleLength!==null&&visibleLength>CAPTURE_CHARACTERS,limitCharacters:CAPTURE_CHARACTERS},
    ...(argumentsText!==null?{functionResponse:{name:options.functionName,arguments:content,characters:argumentsText.length,truncated:argumentsText.length>CAPTURE_CHARACTERS}}:{}),
    ...(typeof message.refusal==='string'?{refusal:message.refusal.slice(0,4000)}:{}),
    ...(responseError?{responseError}:{}),
  }};
}

/** Call only after the response and its usage receipt have been saved. JSON and
 * application schema validation remain the responsibility of each consumer.
 */
export function assertModelResponseUsable(response:ModelResponse):void {
  if(typeof response.metadata.responseError==='string')throw new Error(response.metadata.responseError);
  if(typeof response.content!=='string'||!response.content.trim())throw new Error('Provider returned no text response. No proposed action was accepted.');
  if(response.content.length>CAPTURE_CHARACTERS)throw new Error('Provider response exceeds the bounded contract. No proposed action was accepted.');
}

/** Accept only an entire object or an entire Markdown JSON fence. Never find
 * action JSON inside surrounding prose or repair a partial/malformed object.
 */
export function parseWholeJsonObject(content:string):unknown {
  const text=content.trim(),fence=text.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i);
  const value:unknown=JSON.parse(fence?fence[1].trim():text);
  if(value===null||typeof value!=='object'||Array.isArray(value))throw new SyntaxError('Expected one JSON object.');
  return value;
}

export function normalizeAssistantReply<T extends {reply:string}>(response:ModelResponse,schema:z.ZodType<T>):{value:T|null;warning:string|null}&AssistantResponsePresentation {
  let parsed:unknown;
  try{parsed=parseWholeJsonObject(response.content);}catch{parsed=undefined;}
  const validated=schema.safeParse(parsed);
  const presentation=presentAssistantResponse(response.content);
  if(validated.success&&!response.metadata.responseError)return {value:validated.data,reply:validated.data.reply,...(presentation.clarifications?{clarifications:presentation.clarifications}:{}),warning:null};
  // This permissive projection supplies display only. It never becomes value,
  // the sole source of executable actions and durable memory updates.
  const fields=parsed!==undefined&&!validated.success?validated.error.issues.slice(0,3).map(issue=>issue.path.join('.')||'response').join(', '):'';
  const attemptedEnvelope=parsed!==undefined||/^[{[]/.test(response.content.trim())||response.content.includes('```')||Boolean(presentation.structure);
  const warning=typeof response.metadata.responseError==='string'?response.metadata.responseError:attemptedEnvelope?`The reply ${fields?`has invalid action-contract fields (${fields})`:'contains an incomplete or invalid structured action envelope'}. No actions or memory updates from this response were applied. The bounded response and usage receipt remain saved.`:null;
  return {value:null,...presentation,warning};
}
