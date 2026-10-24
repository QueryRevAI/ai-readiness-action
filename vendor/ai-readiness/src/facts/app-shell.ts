/**
 * The empty application shell: an HTML document over a few KiB that carries almost no text and
 * an application root element, or asks the reader to enable JavaScript. The constants are the
 * ones the site crawler's render decision uses (it imports them from here), so a page is called
 * a shell by one rule everywhere.
 */

/** An empty shell is HTML over this many bytes (5 KB, read as 5 KiB)... */
export const EMPTY_SHELL_MIN_BYTES = 5 * 1024;
/** ...with fewer than this many words of main text... */
export const EMPTY_SHELL_MAX_WORDS = 50;

/**
 * ...and an application root element. Ids that the common frameworks mount into: React
 * (create-react-app, Vite), Vue, Next.js, Nuxt, Gatsby, SvelteKit, Quasar, Remix, Docusaurus.
 */
export const APP_ROOT_IDS: readonly string[] = Object.freeze([
  'root',
  'app',
  '__next',
  '__nuxt',
  '___gatsby',
  'svelte',
  'q-app',
  'remix-root',
  '__docusaurus',
  'main-app',
  'app-root',
]);

/** Elements and attributes that mark an application root besides the ids (Angular, AngularJS, React, Vue SSR). */
export const APP_ROOT_TAG = 'app-root';
export const APP_ROOT_ATTRIBUTES: readonly string[] = Object.freeze([
  'ng-version',
  'ng-app',
  'data-reactroot',
  'data-server-rendered',
]);

/** The same marks as one CSS selector, for a reader that has a DOM. */
export const APP_ROOT_SELECTOR = [
  ...APP_ROOT_IDS.map((id) => `[id="${id}"]`),
  APP_ROOT_TAG,
  ...APP_ROOT_ATTRIBUTES.map((name) => `[${name}]`),
].join(', ');

/** "Enable JavaScript" notices, in the words sites use. */
export const JS_NOTICE =
  /\b(?:enable|turn on|activate|allow)\s+javascript\b|\bjavascript\s+(?:is\s+)?(?:required|disabled|needed|must be enabled|is not enabled|to run this app)\b|\brequires?\s+javascript\b|\bwithout\s+javascript\b/i;

/** Whether one start tag (its name and its attributes by name) is an application root. */
export function isAppRoot(name: string, attributes: ReadonlyMap<string, string>): boolean {
  if (name === APP_ROOT_TAG) return true;
  const id = attributes.get('id');
  if (id !== undefined && APP_ROOT_IDS.includes(id)) return true;
  return APP_ROOT_ATTRIBUTES.some((attribute) => attributes.has(attribute));
}
