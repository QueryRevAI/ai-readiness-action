/**
 * The Organization of a home page: which typed nodes are one, which is the primary node, and
 * what it says about itself.
 */
import { isObject, type JsonObject, type TypedNode } from './json-ld';
import { normalizeHost } from './domain';
import { ORGANIZATION_TYPES } from './schema-org-organization-types';
import { PROFILE_KINDS, profileKind } from './profiles';
import type { OrganizationFacts, ProfileKind } from './types';

const ORGANIZATION_SET: ReadonlySet<string> = new Set(ORGANIZATION_TYPES);
const MAX_SAME_AS_READ = 500;
const MAX_SAME_AS_KEPT = 100;
const MAX_URL_CHARS = 2048;
const NAME_CHARS = 200;

/** Whether a (prefix-free) type name is Organization or one of its schema.org subtypes. */
export function isOrganizationType(name: string): boolean {
  return ORGANIZATION_SET.has(name);
}

/** A string value: a string, the first string of an array, or the `@value` of a value object. */
function textOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      const found = textOf(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (isObject(value) && typeof value['@value'] === 'string') return textOf(value['@value']);
  return null;
}

/** An absolute http(s) URL, parsed; null otherwise. */
function absoluteUrl(text: string | null, base?: string): URL | null {
  if (text === null || text === '' || text.length > MAX_URL_CHARS) return null;
  try {
    const url = base === undefined ? new URL(text) : new URL(text, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The node's `url` as written, when it is an absolute http(s) URL. */
function urlOf(node: JsonObject): string | null {
  const text = textOf(node['url']);
  return absoluteUrl(text) === null ? null : text;
}

function hasLogo(value: unknown, pageUrl: string): boolean {
  if (typeof value === 'string') return absoluteUrl(value.trim(), pageUrl) !== null;
  if (Array.isArray(value)) return value.slice(0, 10).some((item) => hasLogo(item, pageUrl));
  if (isObject(value))
    return typeof value['url'] === 'string' && absoluteUrl(value['url'].trim(), pageUrl) !== null;
  return false;
}

function sameAsValues(value: unknown): string[] {
  const list = Array.isArray(value) ? value.slice(0, MAX_SAME_AS_READ) : [value];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item === 'string') out.push(item);
    else if (isObject(item) && typeof item['@id'] === 'string') out.push(item['@id']);
  }
  return out;
}

export interface OrganizationNode {
  readonly type: string;
  readonly node: JsonObject;
}

/** The Organization nodes among the typed nodes, in document order. */
export function organizationNodes(typed: readonly TypedNode[]): OrganizationNode[] {
  const found: OrganizationNode[] = [];
  for (const { types, node } of typed) {
    const type = types.find((name) => ORGANIZATION_SET.has(name));
    if (type !== undefined) found.push({ type, node });
  }
  return found;
}

/**
 * The primary node: the first Organization node whose `url` is on the site's registrable
 * domain, else the first. Null without any.
 */
export function primaryOrganization(
  nodes: readonly OrganizationNode[],
  siteDomain: string,
  registrable: (host: string) => string,
): OrganizationNode | null {
  for (const candidate of nodes) {
    const url = absoluteUrl(urlOf(candidate.node));
    if (url !== null && registrable(url.hostname) === siteDomain) return candidate;
  }
  return nodes[0] ?? null;
}

/** What the primary node says about itself. */
export function describeOrganization(
  primary: OrganizationNode,
  pageUrl: string,
  siteDomain: string,
  registrable: (host: string) => string,
): OrganizationFacts {
  const node = primary.node;
  const name = textOf(node['name']);
  const url = urlOf(node);
  const seen = new Set<string>();
  const sameAs: string[] = [];
  const kinds = new Set<ProfileKind>();
  for (const text of sameAsValues(node['sameAs'])) {
    const link = absoluteUrl(text.trim());
    if (link === null) continue;
    const host = normalizeHost(link.hostname);
    if (registrable(host) === siteDomain) continue;
    const key = `${host}${link.pathname.replace(/\/+$/, '')}${link.search}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (sameAs.length < MAX_SAME_AS_KEPT) sameAs.push(text.trim());
    kinds.add(profileKind(host));
  }
  return Object.freeze({
    type: primary.type,
    name: name === null ? null : name.slice(0, NAME_CHARS),
    url,
    nameAndUrl: name !== null && url !== null,
    logo: hasLogo(node['logo'], pageUrl),
    sameAs: Object.freeze(sameAs),
    sameAsKinds: Object.freeze(PROFILE_KINDS.filter((kind) => kinds.has(kind))),
  });
}

/** Whether any `potentialAction` of the node is a `SearchAction`. */
export function hasSearchAction(node: JsonObject): boolean {
  const value = node['potentialAction'];
  const list = Array.isArray(value) ? value.slice(0, 20) : [value];
  return list.some((action) => {
    if (!isObject(action)) return false;
    const type = action['@type'];
    const names = Array.isArray(type) ? type : [type];
    return names.some((name) => typeof name === 'string' && /(?:^|[/:])SearchAction$/.test(name));
  });
}
