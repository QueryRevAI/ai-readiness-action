import type { CrawlerPurpose } from '@queryrev/ai-readiness';

export type Level = 'fail' | 'warn' | 'info' | 'pass';

/** One thing the Action found. `id` is stable; the message is one plain sentence. */
export interface ActionFinding {
  readonly id: string;
  readonly level: Level;
  readonly message: string;
  /** The evidence from a file: the deciding line. Untrusted text. */
  readonly snippet?: string;
  /** Where to point an annotation: a file of the checkout and a line in it. */
  readonly file?: string;
  readonly line?: number;
}

export type Access = 'allowed' | 'partial' | 'blocked';

/** One covered crawler at one path, before and after the change. */
export interface AccessRow {
  readonly token: string;
  readonly vendor: string;
  readonly purpose: CrawlerPurpose;
  /** "/" or a path from `check-paths`. */
  readonly path: string;
  /** Null when there is nothing to compare against. */
  readonly before: Access | null;
  readonly after: Access;
  /** Worse than before. */
  readonly worse: boolean;
}
