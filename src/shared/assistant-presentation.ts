import {readAssistantClarifications,type AssistantClarificationQuestion} from './assistant-clarifications.js';
export type {AssistantClarificationQuestion} from './assistant-clarifications.js';
/** Display drafts are never approved actions or a substitute for server validation. */
export type AssistantStructurePreview={
  summary:string;
  validated:false;
  /** kindName: the kind as the canvas names it, where a saved proposal holds the whole block (a Metrics block's tool, a Google Maps block). */
  notes:{id:string;title:string;description:string;kind:'topic'|'activity'|'group';blockType?:string;kindName?:string;parentId:string|null;rationale?:string}[];
  relationships:{source:string;target:string;label:string}[];
};
export type AssistantResponsePresentation={reply:string;question?:string;clarifications?:AssistantClarificationQuestion[];structure?:AssistantStructurePreview};

const INPUT_LIMIT=100000,REPLY_LIMIT=16000;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const clip=(value:string,maximum:number)=>value.length>maximum?value.slice(0,maximum-22)+'\n[Preview truncated.]':value;
const identifier=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128;
const fields=(value:Record<string,unknown>,allowed:string[])=>Object.keys(value).every(key=>allowed.includes(key));

function structurePreview(envelope:Record<string,unknown>):AssistantStructurePreview|undefined{
  let notes:unknown[],relationships:unknown[],summary:unknown;
  if(Array.isArray(envelope.tools)&&envelope.tools.length){
    const tools=envelope.tools.map(object);
    if(tools.length>3||tools.some(tool=>!tool||tool.type!=='notes'||!fields(tool,['type','summary','notes','relationships'])||typeof tool.summary!=='string'||!tool.summary.trim()||!Array.isArray(tool.notes)||!tool.notes.length||tool.notes.length>20||!Array.isArray(tool.relationships)||tool.relationships.length>40))return;
    notes=tools.flatMap(tool=>tool!.notes as unknown[]);relationships=tools.flatMap(tool=>tool!.relationships as unknown[]);summary=tools.map(tool=>tool!.summary).join('\n');
  }else{
    const structure=object(envelope.structure)??envelope;
    if(!Array.isArray(structure.notes)||!Array.isArray(structure.relationships)||typeof structure.summary!=='string')return;
    notes=structure.notes;relationships=structure.relationships;summary=structure.summary;
  }
  // Reject an incomplete or oversized proposal instead of visualizing a subset.
  if(!notes.length||notes.length>20||relationships.length>40||typeof summary!=='string'||!summary.trim())return;
  const projected:AssistantStructurePreview['notes']=[];
  for(const [index,value]of notes.entries()){
    const note=object(value);
    if(!note||!fields(note,['id','title','description','kind','parentId','rationale'])||typeof note.title!=='string'||!note.title.trim()||typeof note.description!=='string'||!['topic','activity','group'].includes(String(note.kind))||!(note.parentId===null||identifier(note.parentId))||(note.id!==undefined&&!identifier(note.id))||(note.rationale!==undefined&&typeof note.rationale!=='string'))return;
    projected.push({id:note.id as string|undefined??`draft-${index+1}`,title:clip(note.title,160),description:clip(note.description,2000),kind:note.kind as 'topic'|'activity'|'group',parentId:note.parentId as string|null,...(typeof note.rationale==='string'?{rationale:clip(note.rationale,1000)}:{})});
  }
  const ids=new Set(projected.map(note=>note.id));if(ids.size!==projected.length)return;
  const parents=new Map(projected.map(note=>[note.id,note.parentId]));
  for(const note of projected){const seen=new Set([note.id]);let parent=note.parentId;while(parent&&ids.has(parent)){if(seen.has(parent))return;seen.add(parent);parent=parents.get(parent)??null;}}
  const links:AssistantStructurePreview['relationships']=[];
  for(const value of relationships){
    const relation=object(value);
    if(!relation||!fields(relation,['source','target','label'])||!identifier(relation.source)||!identifier(relation.target)||typeof relation.label!=='string')return;
    links.push({source:relation.source,target:relation.target,label:clip(relation.label,160)});
  }
  return {summary:clip(summary,400),validated:false,notes:projected,relationships:links};
}

/** Locate bounded complete objects for presentation only. Balanced braces do
 * not repair JSON: every complete candidate still has to parse as JSON.
 */
function objectCandidates(text:string):{complete:string[];partial?:string}{
  const complete:string[]=[];let start=-1,depth=0,quoted=false,escaped=false,maximumDepth=0;
  for(let i=0;i<text.length&&complete.length<8;i++){
    const character=text[i];
    if(start<0){if(character==='{'){start=i;depth=1;maximumDepth=1;quoted=false;escaped=false;}continue;}
    if(quoted){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character==='"')quoted=false;continue;}
    if(character==='"'){quoted=true;continue;}
    if(character==='{'){depth++;maximumDepth=Math.max(maximumDepth,depth);}
    if(character==='}'&&--depth===0){if(maximumDepth<=64)complete.push(text.slice(start,i+1));start=-1;}
  }
  return {complete,...(start>=0?{partial:text.slice(start)}:{})};
}

function jsonString(text:string,start:number):{value:string;end:number}|undefined{
  if(text[start]!=='"')return;
  let escaped=false;
  for(let i=start+1;i<text.length;i++){
    if(escaped){escaped=false;continue;}
    if(text[i]==='\\'){escaped=true;continue;}
    if(text[i]==='"'){try{return {value:JSON.parse(text.slice(start,i+1)) as string,end:i+1};}catch{return;}}
  }
}

/** Only completed top-level reply/question strings can survive incomplete JSON.
 * No notes, relationships or actions are ever reconstructed from a fragment.
 */
function partialStrings(text:string):{reply?:string;question?:string}{
  let depth=0;const found:{reply?:string;question?:string}={};
  for(let i=0;i<text.length;i++){
    const character=text[i];
    if(character==='{'||character==='['){depth++;continue;}if(character==='}'||character===']'){depth--;continue;}
    if(character!=='"')continue;
    const key=jsonString(text,i);if(!key)break;
    if(depth===1){
      let before=i-1;while(before>=0&&/\s/.test(text[before]))before--;
      let colon=key.end;while(/\s/.test(text[colon]??'')&&colon<text.length)colon++;
      if((text[before]==='{'||text[before]===',')&&text[colon]===':'&&(key.value==='reply'||key.value==='question')){
        let start=colon+1;while(start<text.length&&/\s/.test(text[start]))start++;
        const value=jsonString(text,start);if(value&&value.value.trim()){found[key.value]=clip(value.value,key.value==='reply'?REPLY_LIMIT:2000);i=value.end-1;continue;}
      }
    }
    i=key.end-1;
  }
  return found;
}

function fromValue(value:unknown,depth:number):AssistantResponsePresentation|undefined{
  if(depth>4)return;
  if(typeof value==='string')return fromText(value.slice(0,INPUT_LIMIT),depth+1)??{reply:clip(value,REPLY_LIMIT)};
  const envelope=object(value);if(!envelope)return;
  if(typeof envelope.reply==='string'&&envelope.reply.trim()){
    const question=typeof envelope.question==='string'&&envelope.question.trim()?clip(envelope.question,2000):undefined,structure=structurePreview(envelope),clarifications=readAssistantClarifications({clarifications:envelope.clarifications,question:envelope.question});
    return {reply:clip(envelope.reply,REPLY_LIMIT),...(question?{question}:{}),...(clarifications.length?{clarifications}:{}),...(structure?{structure}:{})};
  }
  for(const key of ['response','result','output','content','message','data'])if(Object.hasOwn(envelope,key)){
    const nested=fromValue(envelope[key],depth+1);if(nested)return nested;
  }
}

function fromText(text:string,depth=0):AssistantResponsePresentation|undefined{
  if(depth>4)return;
  try{const result=fromValue(JSON.parse(text.trim()) as unknown,depth);if(result)return result;}catch{/* Display recovery below never participates in action validation. */}
  const fences=[...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)```/gi)].slice(0,8);
  for(const fence of fences){try{const result=fromValue(JSON.parse(fence[1].trim()) as unknown,depth);if(result)return result;}catch{/* Try a complete object, never rebuild a proposal. */}}
  // Some adapters serialize the reply object once more inside prose.
  let strings=0;
  for(let i=0;i<text.length&&strings<8;i++)if(text[i]==='"'){
    const candidate=jsonString(text,i);if(!candidate)continue;i=candidate.end-1;strings++;
    if(/^(?:\s*\{|\s*```)/.test(candidate.value)){const result=fromText(candidate.value,depth+1);if(result)return result;}
  }
  const candidates=objectCandidates(text);
  for(const candidate of candidates.complete){try{const result=fromValue(JSON.parse(candidate) as unknown,depth);if(result)return result;}catch{/* A balanced but malformed object has no structure preview. */}}
  const recovered=partialStrings(candidates.partial??text);
  const clarifications=readAssistantClarifications(recovered);
  return recovered.reply?{reply:recovered.reply,...(recovered.question?{question:recovered.question}:{}),...(clarifications.length?{clarifications}:{})}:undefined;
}

/** Bounded, side-effect-free projection for current and historical saved replies.
 * Wrapped/fenced/prose JSON is a display source only; validated:false is fixed.
 */
export function presentAssistantResponse(content:string):AssistantResponsePresentation{
  const text=content.slice(0,INPUT_LIMIT);
  return fromText(text)??{reply:clip(text,REPLY_LIMIT)};
}
