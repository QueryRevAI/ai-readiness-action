/**
 * Reads the JSON-LD blocks of a page: parses them, keeps those whose top-level `@context` names
 * schema.org, and walks them for typed nodes. The walk is bounded: depth 16, 5,000 nodes. Past
 * a bound the rest is not read and the bound is reported.
 */
import type { JsonLdBound } from './types';

export const MAX_LD_DEPTH = 16;
export const MAX_LD_NODES = 5_000;
const MAX_TYPES_PER_NODE = 20;
const MAX_TYPE_CHARS = 200;

type Json = unknown;
export type JsonObject = Record<string, Json>;

/** A node of the data that has an `@type`. */
export interface TypedNode {
  /** Type names with the schema.org prefixes removed. */
  readonly types: readonly string[];
  readonly node: JsonObject;
}

export interface JsonLdWalk {
  readonly scripts: number;
  readonly parsed: number;
  readonly schemaOrgBlocks: number;
  readonly errors: number;
  readonly bounds: readonly JsonLdBound[];
  /** Typed nodes of the blocks that name schema.org, in document order (parents first). */
  readonly typed: readonly TypedNode[];
}

const SCHEMA_ORG_CONTEXT = /^\s*https?:\/\/(?:www\.)?schema\.org(?:[/#?].*)?$/i;

/** Whether an `@context` value names schema.org (as a string, in an array, or as `@vocab`). */
export function namesSchemaOrg(context: Json): boolean {
  if (typeof context === 'string') return SCHEMA_ORG_CONTEXT.test(context);
  if (Array.isArray(context)) {
    return context.slice(0, 20).some((item) => namesSchemaOrg(item));
  }
  if (isObject(context)) {
    const vocab = context['@vocab'];
    return typeof vocab === 'string' && SCHEMA_ORG_CONTEXT.test(vocab);
  }
  return false;
}

export function isObject(value: Json): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A type name without `schema:` and `http(s)://schema.org/`. */
export function schemaTypeName(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:https?:\/\/(?:www\.)?schema\.org\/|schema:)/i, '')
    .slice(0, MAX_TYPE_CHARS);
}

function typeNames(value: Json): string[] {
  const list = Array.isArray(value) ? value.slice(0, MAX_TYPES_PER_NODE) : [value];
  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim() !== '') names.push(schemaTypeName(item));
  }
  return names;
}

/** The block's text without a wrapping `<!-- -->` or `<![CDATA[ ]]>`, and without a byte order mark. */
export function unwrapBlock(text: string): string {
  let body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  body = body.trim();
  if (body.startsWith('<!--') && body.endsWith('-->')) body = body.slice(4, -3).trim();
  if (body.startsWith('<![CDATA[') && body.endsWith(']]>')) body = body.slice(9, -3).trim();
  return body;
}

/** Parses the blocks and walks the data that names schema.org. */
export function walkJsonLd(
  blocks: readonly string[],
  scripts: number,
  inheritedBounds: readonly JsonLdBound[],
): JsonLdWalk {
  const bounds = new Set<JsonLdBound>(inheritedBounds);
  const typed: TypedNode[] = [];
  let parsed = 0;
  let schemaOrgBlocks = 0;
  let errors = 0;
  let nodes = 0;
  let stopped = false;

  for (const block of blocks) {
    let data: Json;
    try {
      data = JSON.parse(unwrapBlock(block));
    } catch {
      errors += 1;
      continue;
    }
    parsed += 1;
    const roots = Array.isArray(data) ? data.slice(0, 1_000) : [data];
    let named = false;
    for (const root of roots) {
      if (!isObject(root) || !namesSchemaOrg(root['@context'])) continue;
      named = true;
      if (stopped) continue;
      // Depth-first, parents before children, in the order written: the stack takes children
      // in reverse.
      const stack: { value: Json; depth: number }[] = [{ value: root, depth: 1 }];
      while (stack.length > 0 && !stopped) {
        const { value, depth } = stack.pop()!;
        if (depth > MAX_LD_DEPTH) {
          bounds.add('depth');
          continue;
        }
        const children: Json[] = [];
        if (Array.isArray(value)) {
          for (const item of value)
            if (typeof item === 'object' && item !== null) children.push(item);
        } else if (isObject(value)) {
          nodes += 1;
          if (nodes > MAX_LD_NODES) {
            bounds.add('nodes');
            stopped = true;
            break;
          }
          if (Object.hasOwn(value, '@type')) {
            const types = typeNames(value['@type']);
            if (types.length > 0) typed.push({ types, node: value });
          }
          for (const key of Object.keys(value)) {
            if (key === '@context') continue;
            const child = value[key];
            if (typeof child === 'object' && child !== null) children.push(child);
          }
        }
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ value: children[index], depth: depth + 1 });
        }
      }
    }
    if (named) schemaOrgBlocks += 1;
  }
  return Object.freeze({
    scripts,
    parsed,
    schemaOrgBlocks,
    errors,
    bounds: [...bounds],
    typed,
  });
}
