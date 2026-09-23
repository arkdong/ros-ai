import type { ProjectResource } from './research.js';

/** Group only explicit capture lineage. Names, equal data, and URLs alone do
 * not establish that two datasets are versions of the same resource. */
export function groupResources(resources: readonly ProjectResource[]) {
  const groups = new Map<string, ProjectResource[]>();
  for (const resource of resources) {
    const key = resource.originKey || `item:${resource.id}`;
    const existing = groups.get(key) ?? [];
    existing.push(resource); groups.set(key, existing);
  }
  return [...groups].map(([id, versions]) => ({ id, versions: versions.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)) }));
}
