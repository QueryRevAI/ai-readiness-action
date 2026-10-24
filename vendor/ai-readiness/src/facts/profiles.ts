import type { ProfileKind } from './types';

/**
 * Profile kinds of a `sameAs` link, by host. The list is part of the method: a host is the
 * domain or any name under it (`en.wikipedia.org`, `m.facebook.com`).
 */
export const PROFILE_HOSTS: readonly {
  readonly kind: Exclude<ProfileKind, 'other'>;
  readonly hosts: readonly string[];
}[] = Object.freeze([
  { kind: 'wikidata', hosts: ['wikidata.org'] },
  { kind: 'wikipedia', hosts: ['wikipedia.org'] },
  { kind: 'linkedin', hosts: ['linkedin.com'] },
  { kind: 'x', hosts: ['x.com', 'twitter.com'] },
  { kind: 'facebook', hosts: ['facebook.com', 'fb.com'] },
  { kind: 'instagram', hosts: ['instagram.com'] },
  { kind: 'youtube', hosts: ['youtube.com', 'youtu.be'] },
  { kind: 'tiktok', hosts: ['tiktok.com'] },
  { kind: 'github', hosts: ['github.com'] },
  { kind: 'crunchbase', hosts: ['crunchbase.com'] },
  { kind: 'pinterest', hosts: ['pinterest.com'] },
]);

/** The kinds in the order results list them. */
export const PROFILE_KINDS: readonly ProfileKind[] = Object.freeze([
  ...PROFILE_HOSTS.map((entry) => entry.kind),
  'other' as const,
]);

/** The kind of the profile at a host name. */
export function profileKind(host: string): ProfileKind {
  const name = host.toLowerCase();
  for (const entry of PROFILE_HOSTS) {
    if (entry.hosts.some((domain) => name === domain || name.endsWith(`.${domain}`))) {
      return entry.kind;
    }
  }
  return 'other';
}
