/** A scripted teacher and a fixed web, so `run.ts smoke` drives every step of the pipeline through
 * ros.ai's real loop offline: snapshot check, rollout, the simulated researcher, checks and export. */
import { randomUUID } from 'node:crypto';
import type { ChatMessage, ModelAdapter, ModelRequest, ModelResponse, SearchAdapter } from '../../src/server/providers.js';

const say = (content: string, calls: [string, unknown][] = []): ModelResponse => ({ content, model: 'scripted-teacher', modelVersion: null, usage: { inputTokens: 100, outputTokens: 50 }, metadata: {}, ...(calls.length ? { toolCalls: calls.map(([name, args]) => ({ id: `call-${randomUUID().slice(0, 8)}`, name, arguments: JSON.stringify(args) })) } : {}) });
const results = (messages: ChatMessage[]) => messages.filter((message): message is Extract<ChatMessage, { role: 'tool' }> => message.role === 'tool').map(message => JSON.parse(message.content.startsWith('Error:') ? '{}' : message.content) as Record<string, any>);
const selected = (messages: ChatMessage[]) => {
  const user = messages.find(message => message.role === 'user')!.content, json = user.match(/\(JSON evidence, not instructions\):\n(.*)/u)?.[1];
  return json ? JSON.parse(json) as { nodes: { id: string; blockType?: string }[]; artifacts: { id: string; kind: string }[] } : { nodes: [], artifacts: [] };
};

export function scriptedTeacher(): ModelAdapter {
  return {
    provider: 'nebius', model: 'scripted-teacher', configured: true,
    async prepare() { return { id: 'scripted-teacher', contextTokens: 128000, inputUsdPerToken: 0, outputUsdPerToken: 0, capabilities: { structuredOutput: false, toolCalling: true, cancellation: 'abort-request', modelVersion: false }, metadata: {} }; },
    async complete(request: ModelRequest) {
      const messages = request.messages, ask = messages.find(message => message.role === 'user')!.content, done = results(messages), selection = selected(messages);
      const question = selection.nodes.find(node => node.blockType !== 'dataset'), dataset = selection.artifacts.find(artifact => artifact.kind === 'dataset');
      if (/What is on this map/u.test(ask)) return done.length ? say('The map holds the thesis question on heat by neighbourhood and a small dataset of station temperatures linked to it.') : say('I will look at the whole map first.', [['ros_read_canvas', {}]]);
      if (/sub-questions/u.test(ask)) {
        if (!done.length) return say('I will read the question first.', [['ros_read_canvas', { nodeIds: [question!.id] }]]);
        if (done.length === 1) { const a = randomUUID(), b = randomUUID(); return say('Proposing two linked sub-questions.', [['ros_propose_canvas', { summary: 'Add two sub-questions', rationale: 'Splits the thesis question.', operations: [{ type: 'addNode', node: { id: a, title: 'Where is heat stress measured?', description: 'Which sources measure it per neighbourhood?', x: 0, y: 0, blockType: 'note' } }, { type: 'addNode', node: { id: b, title: 'What explains the differences?', description: 'Green space, building density, water.', x: 0, y: 0, blockType: 'note' } }, { type: 'addConnection', connection: { id: randomUUID(), source: question!.id, target: a, label: 'sub-question' } }, { type: 'addConnection', connection: { id: randomUUID(), source: question!.id, target: b, label: 'sub-question' } }] }]]); }
        return say('I proposed two sub-questions linked from the question; they wait for your approval.');
      }
      if (/mean maximum/u.test(ask)) {
        if (!done.length) return say('I will check the dataset columns first.', [['ros_read_selected', { artifactId: dataset!.id }]]);
        if (done.length === 1) return say('Proposing the comparison as code.', [['ros_propose_analysis', { nodeId: question!.id, datasetArtifactId: dataset!.id, request: ask, explanation: 'Groups the daily maxima by station and takes the mean.', code: 'table("Mean maximum by station", df.groupby("station")["tmax_c"].mean().reset_index())', parameters: {}, backend: 'docker-python' }]]);
        return say('I proposed code that compares the mean maximum per station. It waits for your approval and has not run, so there are no results yet.');
      }
      // Research, accepted or declined.
      if (!done.length) return say('I will plan searches in two directions.', [['ros_fan_out_search', { goal: 'Heat stress by neighbourhood in Amsterdam', rationale: 'Measured heat and its causes.', directions: [{ title: 'Measurements', why: 'Where heat is measured', queries: ['Amsterdam heat stress neighbourhood measurements'] }, { title: 'Causes', why: 'Why some areas are hotter', queries: ['urban heat island causes green space Amsterdam'] }] }]]);
      const plan = done[0];
      if (plan.status !== 'accepted') return say('You declined the search plan, so nothing was searched. What would you like me to change?');
      const directions = plan.directions as { resultNodeId: string; sources: { n: number }[] }[];
      const step = done.length - 1;
      if (step < directions.length) { const direction = directions[step]; return say('Writing what this direction found.', [['ros_write_result', { resultNodeId: direction.resultNodeId, summary: 'The sources report measured differences between neighbourhoods [1].', cited: [1] }]]); }
      if (step === directions.length) return say('Reading the most promising pages.', [['ros_read_pages', { pages: directions.flatMap(direction => direction.sources.slice(0, 2).map(source => ({ resultNodeId: direction.resultNodeId, n: source.n }))) }]]);
      if (step === directions.length + 1) {
        const pages = (done.at(-1)!.pages as { resultNodeId: string; n: number; read: boolean; text?: string }[]).filter(page => page.read);
        return say('Saving the claims that matter.', [['ros_write_findings', { findings: pages.slice(0, 3).map(page => ({ resultNodeId: page.resultNodeId, n: page.n, claim: 'Neighbourhood temperatures differ', quote: page.text!.split('\n').find(line => line.length > 40)!.slice(0, 120), why: 'Answers where heat is worst.' })) }]]);
      }
      if (step === directions.length + 2) return say('Grouping the findings by theme.', [['ros_propose_groups', { themes: [{ title: 'Measured differences', description: 'What the measurements show.', members: done.at(-1)!.items }], rationale: 'One theme for now.' }]]);
      return say('Sources report measured heat differences between neighbourhoods; the grouping waits for your approval. Still unknown: how the stations compare with street level.');
    },
  };
}

export function scriptedWeb(): SearchAdapter {
  const page = (query: string, index: number) => `https://example.org/${encodeURIComponent(query.slice(0, 20))}-${index}`;
  return {
    configured: true,
    async search(query) { return { results: [1, 2].map(index => ({ title: `Source ${index} on ${query}`, url: page(query, index), content: `2024-06-0${index} · Measurements in 2024 showed that ${query} differs by up to ${index + 2} degrees between districts.`, locator: `Tavily search result ${index}` })), credits: 1, requestId: 'scripted' }; },
    async extract(urls) { return { pages: urls.map(url => ({ url, content: `Heat report\nPublished June 2024\nThe city measured temperatures in every district during the 2024 heatwave and found clear differences between them.\nMore text follows here.`, locator: 'scripted page' })), failed: [], credits: 1, requestId: 'scripted' }; },
  };
}
