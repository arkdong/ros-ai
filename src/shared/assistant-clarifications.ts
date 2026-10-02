export type AssistantClarificationQuestion={id:string;question:string;options:string[]};
export const ASSISTANT_CLARIFICATION_LIMITS={questions:5,options:8,selectedOptions:2,questionCharacters:2000,optionCharacters:200} as const;
const limits=ASSISTANT_CLARIFICATION_LIMITS;
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;

function explicitQuestions(value:unknown):AssistantClarificationQuestion[]|undefined{
  if(!Array.isArray(value)||!value.length||value.length>limits.questions)return;
  const result:AssistantClarificationQuestion[]=[],ids=new Set<string>();
  for(const item of value){
    const q=object(item);
    if(!q||Object.keys(q).some(key=>!['id','question','options'].includes(key))||typeof q.id!=='string'||!q.id.trim()||q.id.length>128||ids.has(q.id)||typeof q.question!=='string'||!q.question.trim()||q.question.length>limits.questionCharacters||!Array.isArray(q.options)||q.options.length>limits.options||q.options.some(option=>typeof option!=='string'||!option.trim()||option.length>limits.optionCharacters))return;
    const options=(q.options as string[]).map(option=>option.trim());if(new Set(options).size!==options.length)return;
    ids.add(q.id);result.push({id:q.id,question:q.question.trim(),options});
  }
  return result;
}

/** Split only an explicit list already written by the model. No generic answer
 * suggestions or domain choices are supplied by this presentation helper.
 */
function optionsFromText(source:string):string[]{
  const text=source.trim().replace(/^(?:e\.g\.?|for example|such as|options?|choices?)\s*[:,]?\s*/i,'');
  const pieces:string[]=[];let start=0,depth=0,quote='',escaped=false;
  for(let i=0;i<text.length;i++){
    const character=text[i];
    if(quote){if(escaped)escaped=false;else if(character==='\\')escaped=true;else if(character===quote)quote='';continue;}
    if(character==='"'||character==="'"&&(i===0||/\s|[(,]/.test(text[i-1]))){quote=character;continue;}
    if(character==='('||character==='['){depth++;continue;}if(character===')'||character===']'){if(!depth)return [];depth--;continue;}
    if(depth)continue;
    const or=text.slice(i).match(/^\s+or\s+/i);
    if(character===','||character===';'||character==='|'||or){pieces.push(text.slice(start,i));i+=or?or[0].length-1:0;start=i+1;}
  }
  if(depth||quote)return [];pieces.push(text.slice(start));
  const candidates=pieces.map(value=>value.trim().replace(/^(?:and|or)\s+/i,'').replace(/[.?;]$/,'')).filter(value=>value&&!/^(?:etc\.?|and so on|something else|anything else|other(?: option)?)$/i.test(value));
  return candidates.length>=2&&candidates.length<=limits.options&&candidates.every(value=>value.length<=limits.optionCharacters)&&new Set(candidates).size===candidates.length?candidates:[];
}

function legacyQuestion(text:string,index:number):AssistantClarificationQuestion{
  const original=text.trim(),lettered=[...original.matchAll(/(?:^|\s)(?:\(([a-h])\)|([a-h])[.)])\s+/gi)];
  if(lettered.length>=2&&lettered.length<=limits.options){
    const options=lettered.map((match,i)=>original.slice(match.index!+match[0].length,lettered[i+1]?.index??original.length).trim().replace(/[;,]$/,''));
    const question=original.slice(0,lettered[0].index).trim().replace(/(?:options?|choices?)\s*:\s*$/i,'').trim();
    if(question&&options.every(value=>value&&value.length<=limits.optionCharacters)&&new Set(options).size===options.length)return {id:`legacy-q${index+1}`,question:question.slice(0,limits.questionCharacters),options};
  }
  const lines=original.split(/\r?\n/),bullets=lines.slice(1).map(line=>line.match(/^\s*[-*•]\s+(.+)$/)?.[1]?.trim());
  if(bullets.length>=2&&bullets.length<=limits.options&&bullets.every((value):value is string=>Boolean(value)&&value!.length<=limits.optionCharacters)&&new Set(bullets).size===bullets.length)return {id:`legacy-q${index+1}`,question:lines[0].trim().slice(0,limits.questionCharacters),options:bullets};
  const marked=original.match(/\b(?:options?|choices?)\s*:\s*(.+)$/i);
  if(marked){const options=optionsFromText(marked[1]);if(options.length)return {id:`legacy-q${index+1}`,question:(original.slice(0,marked.index).trim()||original).slice(0,limits.questionCharacters),options};}
  const parenthetical:string[]=[];let start=-1,depth=0;
  for(let i=0;i<original.length;i++){if(original[i]==='('){if(!depth)start=i+1;depth++;}else if(original[i]===')'&&depth&&!--depth&&start>=0)parenthetical.push(original.slice(start,i));}
  for(const body of parenthetical){
    if(!/^(?:e\.g\.?|for example|such as|options?|choices?)\b/i.test(body.trim())&&!/[;|]|\s+or\s+/i.test(body))continue;
    const options=optionsFromText(body);
    if(options.length)return {id:`legacy-q${index+1}`,question:original.slice(0,limits.questionCharacters),options};
  }
  const examples=original.match(/\b(?:e\.g\.?|for example|such as)\s*[:,]?\s+([^\n]+)(?:$|\n)/i);
  if(examples){const options=optionsFromText(examples[1]);if(options.length)return {id:`legacy-q${index+1}`,question:original.slice(0,limits.questionCharacters),options};}
  const labelled=original.match(/^(.*?)\s(?:—|–|-)\s+(.+)$/);
  if(labelled&&labelled[2].includes(',')&&/\bor\b/i.test(labelled[2])){
    const wording=labelled[2].replace(/^(?:would you (?:prefer|like)|do you (?:prefer|want)|are you (?:looking for|aiming for))\s+/i,'');
    const options=optionsFromText(wording);if(options.length)return {id:`legacy-q${index+1}`,question:original.slice(0,limits.questionCharacters),options};
  }
  return {id:`legacy-q${index+1}`,question:original.slice(0,limits.questionCharacters),options:[]};
}

/** Historical scalar questions remain readable. Numbering supplies boundaries,
 * while parentheses, letter labels or explicit bullets may supply choices.
 */
export function parseLegacyClarifications(question:string):AssistantClarificationQuestion[]{
  const text=question.slice(0,limits.questionCharacters).trim();if(!text)return [];
  const numbered=[...text.matchAll(/(?:^|\n)\s*(?:\*\*)?\d{1,2}[.)](?:\*\*)?\s+/g)];
  const markers=numbered.length>=2?numbered:[...text.matchAll(/(?:^|\s)\d{1,2}[.)]\s+(?=[A-Z*])/g)];
  if(markers.length>=2&&markers.length<=limits.questions)return markers.map((match,i)=>legacyQuestion(text.slice(match.index!+match[0].length,markers[i+1]?.index??text.length),i));
  return [legacyQuestion(text,0)];
}

export function readAssistantClarifications(value:{clarifications?:unknown;question?:unknown}):AssistantClarificationQuestion[]{
  const explicit=explicitQuestions(value.clarifications);if(explicit)return explicit;
  return typeof value.question==='string'?parseLegacyClarifications(value.question):[];
}
