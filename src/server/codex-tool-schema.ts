/** A tool's input schema as Codex takes it.
 *
 * Codex keeps a small part of JSON Schema and measures what is left: over 5,000 bytes it strips the descriptions, then
 * any shared definitions, then empties every object three levels down. That is what happened to ros_propose_canvas,
 * whose five operations reached the model as five shapes of nothing, so Codex guessed at every canvas change.
 * Here the schema is first cut to the part Codex keeps. Where that is still too long, an object that repeats the
 * fields of another (updateNode's patch repeats the block fields of addNode's node) is described by naming the other,
 * so the fields are spelled out once. ros.ai checks the arguments against the full schema either way. */
type Schema = { [key: string]: unknown };

/** Past this many bytes Codex starts cutting a tool's input schema down. */
export const CODEX_SCHEMA_LIMIT = 5000;
/** What a schema is brought under, so a small addition to a tool does not take it over the limit. */
const TARGET = 4600;
const KEPT = ['$ref', 'type', 'description', 'enum', 'items', 'minItems', 'properties', 'required', 'additionalProperties', 'anyOf', 'oneOf', 'allOf', '$defs'] as const;
const PLAIN = ['string', 'number', 'integer', 'boolean'];
const isSchema = (value: unknown): value is Schema => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const each = (value: unknown) => isSchema(value) ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, kept(child)])) : {};

/** The part of a schema Codex keeps: no lengths, patterns or ranges, a fixed value as a one-value enum, and "this or
 * nothing" as two types rather than a choice between two schemas. */
function kept(value: unknown): Schema {
  if (!isSchema(value)) return {};
  const out: Schema = {};
  for (const key of KEPT) {
    const item = value[key];
    if (item === undefined) continue;
    if (key === 'properties' || key === '$defs') out[key] = each(item);
    else if (key === 'items') out[key] = kept(item);
    else if (key === 'additionalProperties') out[key] = typeof item === 'boolean' ? item : kept(item);
    else if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') out[key] = Array.isArray(item) ? item.map(kept) : [];
    else out[key] = item;
  }
  if ('const' in value && out.enum === undefined) out.enum = [value.const];
  if (out.type === 'object' && out.properties === undefined) out.properties = {};
  const choice = out.anyOf as Schema[] | undefined, nothing = choice?.length === 2 ? choice.findIndex(item => item.type === 'null' && Object.keys(item).length === 1) : -1;
  if (choice && nothing >= 0 && Object.keys(out).every(key => key === 'anyOf' || key === 'description')) {
    const other = choice[1 - nothing];
    if (PLAIN.includes(other.type as string) && Object.keys(other).every(key => key === 'type' || key === 'description')) return { ...other, ...(out.description === undefined ? {} : { description: out.description }), type: [other.type, 'null'] };
  }
  return out;
}

/** Every object with fields inside a schema, with the name of the field that holds it. */
function* objects(schema: Schema, name = ''): Generator<{ schema: Schema; name: string; fields: Record<string, unknown> }> {
  if (isSchema(schema.properties)) {
    if (Object.keys(schema.properties).length) yield { schema, name, fields: schema.properties };
    for (const [key, child] of Object.entries(schema.properties)) if (isSchema(child)) yield* objects(child, key);
  }
  for (const child of [schema.items, schema.additionalProperties, ...['anyOf', 'oneOf', 'allOf'].flatMap(key => Array.isArray(schema[key]) ? schema[key] as unknown[] : [])]) if (isSchema(child)) yield* objects(child, name);
}

/** Describes the largest object that only repeats fields of another by naming that other. False when there is none. */
function nameOneRepeat(root: Schema): boolean {
  const all = [...objects(root)].map(item => ({ ...item, texts: Object.fromEntries(Object.entries(item.fields).map(([key, field]) => [key, JSON.stringify(field)])) }));
  let best: { repeat: Schema; of: typeof all[number]; size: number } | null = null;
  for (const repeat of all) for (const of of all) {
    if (repeat === of || !of.name || Object.keys(repeat.texts).length < 4 || Object.keys(repeat.texts).length > Object.keys(of.texts).length) continue;
    if (!Object.entries(repeat.texts).every(([key, text]) => of.texts[key] === text)) continue;
    const size = bytes(repeat.schema);
    if (!best || size > best.size) best = { repeat: repeat.schema, of, size };
  }
  if (!best) return false;
  const only = Object.keys(best.of.texts).filter(key => !(key in (best.repeat.properties as Schema)));
  const own = typeof best.repeat.description === 'string' ? `${best.repeat.description} ` : '';
  for (const key of Object.keys(best.repeat)) delete best.repeat[key];
  Object.assign(best.repeat, { type: 'object', description: `${own}Any of the fields "${best.of.name}" takes, with the same types${only.length ? ` (not ${only.join(', ')})` : ''}.`, properties: {}, additionalProperties: true });
  return true;
}

/** One tool's input schema as Codex is given it: the part Codex keeps, under its size limit. */
export function codexToolSchema(schema: unknown): Schema {
  const out = kept(schema);
  while (bytes(out) > TARGET && nameOneRepeat(out));
  return out;
}
