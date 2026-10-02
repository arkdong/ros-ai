/** User-directed, undoable restructuring of two existing demonstrations. No
 * execution or provider request, and no changes to immutable evidence/history. */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Store } from '../src/server/store.js';
import type { Mutation, CanvasNode } from '../src/shared/types.js';
import type { ResearchMemory } from '../src/shared/assistant.js';

if (!process.argv.includes('--apply')) throw Error('Pass --apply for the authorized four-stage restructuring.');
const store = new Store('.ros-ai', { recoverInterrupted: false });
const stages = ['stage-explore', 'stage-evidence', 'stage-analyze', 'stage-draft'];
const titles = ['01 · Explore the question', '02 · Gather evidence', '03 · Analyze and challenge', '04 · Draft'];
const definitions = [
  {
    projectId: '67e23d18-f399-46ed-9698-147e7d9d5f2c',
    broad: 'How is AI adoption changing Dutch businesses, and what could that mean for banks such as ABN AMRO?',
    focused: 'How does reported AI use differ by company size in CBS 2024, and how do turnover denominators and excluded microbusinesses limit banking interpretations?',
    descriptions: [
      'Begin with Dutch AI adoption and its possible relevance to banking. The saved exploration narrows the broad idea to an answerable question about reported use by company size. Output: the focused CBS comparison, with causal claims left open.',
      'Output: six compatible 2024 CBS size groups and a source map. Separate published statistics, attributed banking context and population limits. Under-ten enterprises are excluded; enterprise share and turnover share have different denominators.',
      'Output: two actual saved local Python analyses and plots. The measured size gap is 41.4 percentage points; turnover belonging to adopters is not revenue caused by AI. Challenge the interpretation before developing qualified banking questions.',
      'Output: an editable cited article with exact selected figures and the challenge in its main text. AURORA guidance informs writing style and belongs beside the draft; it is not factual evidence. Prepared writing and new live refinement remain distinguishable.',
    ],
    groups: [ ['dutch-ai-brief','dutch-ai-direction'], ['dutch-ai-sources','dutch-ai-data'], ['dutch-ai-analysis','dutch-ai-challenge','dutch-ai-synthesis'], ['dutch-ai-writing-reference','dutch-ai-article'] ],
    childTitles: { 'dutch-ai-brief':'Begin with the banking question', 'dutch-ai-direction':'Focused question · a comparable company-size study', 'dutch-ai-sources':'Evidence and banking context', 'dutch-ai-data':'CBS data · population and denominators', 'dutch-ai-analysis':'Measure the adoption gap', 'dutch-ai-challenge':'Challenge what the numbers mean', 'dutch-ai-synthesis':'Qualified implications for a bank', 'dutch-ai-article':'Editable article · grounded in the challenge' } as Record<string,string>,
  },
  {
    projectId: 'bff8fb76-ee4b-433b-9b27-e8cf3ab19ce4',
    broad: 'How well does a simple historical risk baseline describe losses as market conditions change?',
    focused: 'How does a 95% historical loss threshold using 252 strictly preceding daily observations behave across the eligible 2019–2021 S&P 500 sample, and what does its year-by-year performance leave unresolved?',
    descriptions: [
      'Start with how historical risk estimates respond to changing markets. Explore what an exceedance can and cannot tell us. Output: an answerable question about a declared prior-observations baseline, rather than an assumed finding about future risk.',
      'Output: selected source and method evidence with coverage and rights. The existing FRED S&P 500 capture is a price index without dividends; retain missingness, date coverage and redistribution limits. New source research is distinguished from this prepared record.',
      'Output: inspectable thresholds, exceedance counts and plots from actual saved local computation. All thresholds use preceding losses. Challenge sensitivity and interpretations without implying causal effects, future calibration or a trading rule.',
      'Output: an editable short research paper joining question, related evidence, data, method, results and limitations. Citations and exact outputs remain inspectable. Preserve prepared, newly searched, inferred and calculated contributions separately.',
    ],
    groups: [ ['question'], ['source'], ['method','analysis','challenge'], ['conclusion'] ],
    childTitles: { 'question':'Explore historical risk and changing conditions', 'source':'Observed prices · source, coverage and rights', 'method':'A declared prior-observations method', 'analysis':'Measure subsequent threshold breaches', 'challenge':'Challenge interpretation and sensitivity', 'conclusion':'Prepared baseline conclusion' } as Record<string,string>,
  },
];
try {
  const results = [];
  for (const definition of definitions) {
    const before = store.detail(definition.projectId);
    const marker = 'four-stage-2026-09-23';
    if (store.record('demo-structure', `${marker}:${definition.projectId}`)) { results.push({projectId:definition.projectId,status:'already applied'}); continue; }
    const operations:Mutation[] = stages.map((id,index) => ({type:'addNode',node:{id,title:titles[index],description:definition.descriptions[index],kind:'topic',parentId:null,width:440,x:index%2*648,y:Math.floor(index/2)*552}}));
    definition.groups.forEach((children,stage) => children.forEach((id,index) => {
      const existing=before.project.canvas.nodes.find(node=>node.id===id);
      if (!existing) throw Error(`Expected existing note ${id}; no partial mutation applied.`);
      operations.push({type:'updateNode',id,patch:{parentId:stages[stage],title:definition.childTitles[id]??existing.title,x:0,y:index*504,width:440}});
    }));
    const focusedId=definition.projectId.startsWith('67e')?'dutch-ai-direction':'focused-question';
    if (focusedId==='focused-question') {
      const node:CanvasNode={id:focusedId,title:'Focused question · evaluate a declared baseline',description:`Current exploratory direction: ${definition.broad}\n\nFocused question emerging from the prepared source and baseline review: ${definition.focused}\n\nThe existing sample offers a descriptive retrospective check. It does not establish out-of-sample calibration, and 2020 is a declared comparison rather than a discovered universal market regime. New provider research, when authorized and performed, may refine this question; it is not represented as already completed.`,kind:'topic',parentId:stages[0],x:0,y:504,width:440};
      operations.push({type:'addNode',node},{type:'addConnection',connection:{id:randomUUID(),source:'question',target:focusedId,label:'narrows to'}},{type:'addConnection',connection:{id:randomUUID(),source:focusedId,target:'source',label:'defines evidence needed'}});
    } else operations.push({type:'updateNode',id:focusedId,patch:{description:`Focused question: ${definition.focused}\n\nThe source exploration established six compatible provisional size bins. Banking surveys are separate context, not a trend or causal comparator. This focused question emerged from that evidence and remains narrower than the original broad banking question.`}});
    store.atomic(()=>{
      store.mutate(definition.projectId,operations,'Organize existing research into four expandable stages; preserve all evidence and history',before.project.revision);
      const at=new Date().toISOString();
      const memory=store.record<ResearchMemory>('research-memory',definition.projectId)??{originalQuestion:definition.broad,questionHistory:[],decisions:[],findings:[],hypotheses:[],gaps:[]};
      // Original question is historical provenance. Append the new direction.
      for(const text of [definition.broad,definition.focused]) if(!memory.questionHistory.some(item=>item.text===text))memory.questionHistory.push({id:randomUUID(),text,at});
      memory.decisions.push({id:randomUUID(),kind:'decision',status:'recorded',text:'User-directed four-stage organization: explore → focused question; gather → selected evidence; analyze/challenge → qualified findings; draft → cited editable writing. Relationships do not schedule work or import inputs.',at,references:stages.map((id,index)=>({kind:'node',id,label:titles[index]}))});
      store.saveRecord('research-memory',definition.projectId,definition.projectId,memory);
      store.saveRecord('demo-structure',`${marker}:${definition.projectId}`,definition.projectId,{at,stages,previousRevision:before.project.revision,preservedArtifactIds:before.artifacts.map(a=>a.id),preservedRunIds:before.runs.map(r=>r.id),broadQuestion:definition.broad,focusedQuestion:definition.focused});
    });
    const after=store.detail(definition.projectId);
    if(after.artifacts.length!==before.artifacts.length||after.runs.length!==before.runs.length||after.inputs.length!==before.inputs.length)throw Error('Unexpected evidence count change during structural-only operation.');
    results.push({projectId:definition.projectId,stages:after.project.canvas.nodes.filter(node=>!node.parentId).map(node=>({id:node.id,title:node.title})),revision:after.project.revision,preservedArtifacts:before.artifacts.length,preservedRuns:before.runs.length,preservedSelections:before.inputs.length});
  }
  writeFileSync('outputs/four-stage-restructure.json',JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
} finally { store.close(); }
