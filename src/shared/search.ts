/** The web search services ros.ai can search with. Tavily came first; Exa and Brave Search work the same way,
 * each with its own key on the Plugins page. One of them is in use at a time. */
export const searchProviders = ['tavily', 'exa', 'brave'] as const;
export type SearchProviderId = typeof searchProviders[number];
export const isSearchProvider = (value: string): value is SearchProviderId => (searchProviders as readonly string[]).includes(value);
export const searchLabels: Record<SearchProviderId, string> = { tavily: 'Tavily', exa: 'Exa', brave: 'Brave Search' };
/** The label after its article, as a sentence names it: "a Tavily", "an Exa". */
export const aSearchLabel = (id: SearchProviderId) => `${id === 'exa' ? 'an' : 'a'} ${searchLabels[id]}`;

/** active: the service searches use now (the chosen one while it has a key, else the first with a key), null with no key at all. */
export type SearchServiceStatus = {
  active: SearchProviderId | null;
  chosen: SearchProviderId | null;
  services: { id: SearchProviderId; label: string; configured: boolean; readsPages: boolean }[];
};
