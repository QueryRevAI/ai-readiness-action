/**
 * Word counting by the Unicode word-break rules (`Intl.Segmenter`, word-like segments), so
 * a page in Chinese or Japanese is counted too, where splitting on spaces would find one word.
 */

/** Counting stops here: no rule of the library looks past it, and a page cannot make it slow. */
export const MAX_WORDS_COUNTED = 100_000;
/** Characters given to the word-break rules at most (text that is not plain ASCII). */
export const MAX_SEGMENTED_CHARS = 512 * 1024;

const SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' });

/**
 * A word in plain ASCII text, as the word-break rules see it: a run of letters and digits, with
 * a `.`, `'` or `:` joining two letters, or a `.`, `'`, `,` or `;` joining two digits. A test
 * checks this against `Intl.Segmenter` on random text, so it only makes the common case fast.
 */
const ASCII_WORD =
  /[A-Za-z0-9]+(?:(?:(?<=[A-Za-z])[.':](?=[A-Za-z])|(?<=[0-9])[.',;](?=[0-9]))[A-Za-z0-9]+)*/g;
// eslint-disable-next-line no-control-regex
const PLAIN_ASCII = /^[\u0000-\u007f]*$/;

export interface WordCount {
  readonly words: number;
  /** The count is a lower bound: counting stopped at the word limit or the character limit. */
  readonly capped: boolean;
}

/** Words in `text`, counted up to `limit`. Linear in the length of the text. */
export function countWords(text: string, limit: number = MAX_WORDS_COUNTED): WordCount {
  let words = 0;
  if (PLAIN_ASCII.test(text) && !text.includes('_')) {
    ASCII_WORD.lastIndex = 0;
    while (ASCII_WORD.exec(text) !== null) {
      words += 1;
      if (words >= limit) return { words, capped: true };
    }
    return { words, capped: false };
  }
  const cut = text.length > MAX_SEGMENTED_CHARS;
  for (const segment of SEGMENTER.segment(cut ? text.slice(0, MAX_SEGMENTED_CHARS) : text)) {
    if (!segment.isWordLike) continue;
    words += 1;
    if (words >= limit) return { words, capped: true };
  }
  return { words, capped: cut };
}
