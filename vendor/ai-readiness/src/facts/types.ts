import type { TextFetcher } from '../net/fetch-text';

/**
 * The result types of the readers and of `checkSite`. They are plain data (no classes, no
 * functions), so a result can be written to JSON and read back: the study runner, the check
 * pages and the command line all build on these shapes.
 *
 * Nothing here is a score. A check returns findings with evidence; counts and shares are for
 * whoever collects many of them.
 */

/** One result of a check, stable enough to be matched by `id` across versions. */
export type FindingLevel = 'pass' | 'warn' | 'fail' | 'info';

export interface Finding {
  /** Stable name of the check (`organization-schema`, `sitemap-valid`). Never reused. */
  readonly id: string;
  readonly level: FindingLevel;
  /** One plain sentence about this site. */
  readonly message: string;
  /** Where the check is explained. */
  readonly docUrl: string;
  /** The evidence: the line, value or text the finding rests on, cut short. */
  readonly snippet?: string;
}

/** How much of the home page's text is in the HTML as served. */
export type HomeContent = 'text_in_html' | 'little_text' | 'app_shell';

/** Where a profile in `sameAs` points, by host. */
export type ProfileKind =
  | 'wikidata'
  | 'wikipedia'
  | 'linkedin'
  | 'x'
  | 'facebook'
  | 'instagram'
  | 'youtube'
  | 'tiktok'
  | 'github'
  | 'crunchbase'
  | 'pinterest'
  | 'other';

/** Where the organization was found. JSON-LD wins over microdata. */
export type OrganizationSource = 'json_ld' | 'microdata' | 'none';

/** A limit of the JSON-LD reader that was reached; the rest of the data was not read. */
export type JsonLdBound = 'blocks' | 'block_size' | 'total_size' | 'depth' | 'nodes';

/** What the page says about its primary Organization node. */
export interface OrganizationFacts {
  /** The node's `@type` that names Organization or one of its subtypes. */
  readonly type: string;
  /** The node's `name`, as written, cut to 200 characters; null without a usable one. */
  readonly name: string | null;
  /** The node's `url` when it is an absolute http(s) URL, else null. */
  readonly url: string | null;
  /** A non-empty `name` and an absolute http(s) `url`. */
  readonly nameAndUrl: boolean;
  /** `logo` is a URL, or an ImageObject with a `url`. */
  readonly logo: boolean;
  /**
   * The distinct `sameAs` URLs (absolute http(s), not on the site's own registrable domain),
   * at most 100, in the order written.
   */
  readonly sameAs: readonly string[];
  /** The kinds of `sameAs`, each once, in a fixed order. */
  readonly sameAsKinds: readonly ProfileKind[];
}

/** What the `<script type="application/ld+json">` blocks of the page held. */
export interface JsonLdFacts {
  /** ld+json scripts read (at most 50). */
  readonly scripts: number;
  /** Scripts that parse as JSON. */
  readonly parsed: number;
  /** Scripts that parse and whose top-level `@context` names schema.org. */
  readonly schemaOrgBlocks: number;
  /** Scripts that do not parse. */
  readonly errors: number;
  /** The limits that were reached, each once. Empty when the whole page was read. */
  readonly bounds: readonly JsonLdBound[];
}

/** Everything `readHomePage` reads from one page. */
export interface HomePageFacts {
  /** The address the page was read at (the final one, after redirects). */
  readonly url: string;
  readonly host: string;
  /** Size of the HTML in bytes (UTF-8). */
  readonly bytes: number;
  /** The scan stopped at its limit, so the end of a very large page was not read. */
  readonly scanTruncated: boolean;
  /** Words of main text; a lower bound when `wordsCapped`. */
  readonly mainWords: number;
  /** Counting stopped at its word limit or its character limit, so `mainWords` is a lower bound. */
  readonly wordsCapped: boolean;
  /** Whether the words are those of `<main>` / `[role=main]` or of the body less its chrome. */
  readonly mainSource: 'main' | 'body';
  readonly content: HomeContent;
  /** An application root element is present (`#root`, `#__next`, `app-root`, and the rest). */
  readonly appRoot: boolean;
  /** The page asks the reader to enable JavaScript. */
  readonly jsNotice: boolean;
  /** A small page whose title or visible text is that of a bot check (a 202 is decided apart). */
  readonly botCheck: boolean;
  readonly noindex: boolean;
  readonly noindexSource: 'meta' | 'header' | 'both' | null;
  readonly jsonLd: JsonLdFacts;
  /** schema.org type names found in JSON-LD and microdata, each once, at most 200. */
  readonly types: readonly string[];
  /** The `itemtype` values of the microdata, as type names, each once. */
  readonly microdataTypes: readonly string[];
  readonly organization: OrganizationSource;
  /** Type of the primary node, or the first Organization type seen in microdata. */
  readonly organizationType: string | null;
  /** The primary Organization node of the JSON-LD; null without one. */
  readonly primary: OrganizationFacts | null;
  /** A `WebSite` node. */
  readonly website: boolean;
  /** A `WebSite` node with a `potentialAction` of type `SearchAction`. */
  readonly searchAction: boolean;
  /** A `FAQPage` node (JSON-LD or microdata). */
  readonly faqPage: boolean;
}

export type SitemapOutcome = 'valid' | 'not_a_sitemap' | 'malformed';

/** Why a file is not a valid sitemap. */
export type SitemapReason =
  | 'html'
  | 'empty'
  | 'doctype'
  | 'bad_root'
  | 'no_loc'
  | 'off_site'
  | 'not_closed'
  | 'text_lines'
  | 'gzip_failed';

/** What `readSitemap` found in one file. */
export interface SitemapFacts {
  readonly outcome: SitemapOutcome;
  /** `urlset` and `index` are XML (sitemaps.org); `text` is one URL per line. */
  readonly kind: 'urlset' | 'index' | 'text' | null;
  readonly reason: SitemapReason | null;
  /** `<loc>` entries (or text lines) counted, up to 100,000. */
  readonly locs: number;
  /** The file was gzip and was inflated. */
  readonly gzip: boolean;
  /** The file was cut at the size cap: it is valid as far as it was read. */
  readonly truncated: boolean;
  /** Bytes read after decompression. */
  readonly bytes: number;
}

/** Why the home page counts as read or not. */
export type HomeOutcome =
  | 'read'
  /** robots.txt keeps this reader from `/`. */
  | 'not_allowed'
  | 'forbidden'
  | 'challenge'
  | 'placeholder'
  | 'not_html'
  | 'error_status'
  | 'off_site'
  | 'redirect_error'
  | 'network';

/** The robots.txt of a site as a check read it. */
export type RobotsOutcome =
  /** A file, parsed. */
  | 'file'
  /** A 4xx (not 401, 403, 429): there is no file, and nothing is closed. */
  | 'missing'
  /** Not read: 401, 403, 429, 5xx, a bot check, or no answer. Nothing more is asked. */
  | 'not_read';

export interface RobotsRead {
  readonly outcome: RobotsOutcome;
  readonly url: string;
  readonly status: number | null;
  readonly bytes: number;
  readonly truncated: boolean;
  /** `Sitemap:` lines, as written. */
  readonly sitemaps: readonly string[];
  /** Whether this reader's own token may fetch `/`. True without a file. */
  readonly allowsThisReader: boolean;
}

export interface HomeRead {
  readonly outcome: HomeOutcome;
  readonly requestedUrl: string;
  /** The last URL requested; the page was read there. */
  readonly finalUrl: string;
  readonly status: number | null;
  readonly redirects: number;
  readonly truncated: boolean;
  /** Present when the outcome is `read`. */
  readonly facts: HomePageFacts | null;
}

export interface LlmsRead {
  /** False when robots.txt keeps this reader from the file. */
  readonly asked: boolean;
  readonly present: boolean;
  /** The verdict of `validateLlmsTxt`; null when not asked. */
  readonly verdict: string | null;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly h1: string | null;
  readonly sections: number;
  readonly links: number;
}

export type SitemapSource = 'robots' | 'well_known';

export interface SitemapRead {
  /** False when robots.txt keeps this reader from the file, or the robots.txt was not read. */
  readonly asked: boolean;
  readonly source: SitemapSource | null;
  readonly url: string | null;
  readonly status: number | null;
  /** Null when the file was not read or the answer was not 2xx. */
  readonly facts: SitemapFacts | null;
}

/** Access of one covered crawler to `/`, from the site's robots.txt. */
export interface CrawlerRootAccess {
  readonly token: string;
  readonly purpose: 'training' | 'search' | 'user';
  readonly access: 'allowed' | 'partial' | 'blocked';
  /** The crawler may fetch `/`. */
  readonly root: boolean;
}

/** The result of `checkSite`: facts gathered from files, and the findings drawn from them. */
export interface SiteCheck {
  readonly schemaVersion: 1;
  /** The site as asked: scheme and host. */
  readonly origin: string;
  readonly host: string;
  /** The crawlers-covered line every report carries. */
  readonly crawlersCovered: string;
  readonly robots: RobotsRead;
  /** The covered crawlers' access; empty when robots.txt was not read. */
  readonly crawlerAccess: readonly CrawlerRootAccess[];
  /** Null when no request was made (robots.txt not read, or `/` not allowed). */
  readonly home: HomeRead | null;
  readonly llms: LlmsRead;
  readonly sitemap: SitemapRead;
  readonly findings: readonly Finding[];
}

export interface CheckOptions {
  /** Reads files over the guarded network layer. By default one is made and closed per check. */
  readonly fetcher?: TextFetcher;
  /** The caller's overall budget; by default 30 seconds. */
  readonly signal?: AbortSignal;
  /**
   * Maps a host name to its registrable domain. The built-in rule knows the common two-label
   * suffixes only; pass a full public-suffix lookup to be exact.
   */
  readonly registrableDomain?: (host: string) => string;
}
