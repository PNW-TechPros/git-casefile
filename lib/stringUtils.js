export const ENDL_PATTERN = /\r?\n|\r/;
const MAYBE_ENDL_AT_END_PATTERN = new RegExp(`(?:${ENDL_PATTERN.source})?$`);

/**
 * @summary Split a string into lines
 * @param {string} s - String to split
 * @returns {Array.<string>} Lines in *s* (without newlines)
 *
 * @description
 * The property `trailingEndl` of the result is assigned a boolean value
 * indicating whether *s* ended with an end-of-line sequence.  The last entry
 * of the result will only be empty if *s* ends with two or more end-of-line
 * sequences.
 *
 * Recognized end-of-lines are `'\r\n'`, `'\n'`, and `'\r'`.
 */
export function splitIntoLines(s) {
  const match = MAYBE_ENDL_AT_END_PATTERN.exec(s);
  s = s.slice(0, match.index);
  const result = s.split(ENDL_PATTERN);
  result.trailingEndl = match.index !== s.length;
  return result;
}

/**
 * @summary Reverse string partition (split)
 * @param {string} s - The string to be split
 * @param {string} sep - The separator between result parts
 * @param {number} [maxCount=Infinity] - The maximum number of groups to return
 * @returns {Array.<string>} The separated parts of *s*
 *
 * @description
 * Somewhat similar to `String.prototype.split()`, this function divides the
 * input string *s* at each *sep* starting from the right.  However, in a
 * difference from `String.prototype.split()`, element 0 of the result will
 * always contain the part of *s* before the first separator; if more than
 * *maxCount* - 1 instances of *sep* occur in *s*, the additional instances
 * of *sep* will be part of element 0 of the result.
 */
export function strrpart(s, sep, maxCount = Infinity) {
  const result = [];
  for (let start = Infinity; start >= 0; ) {
    if (result.length + 1 >= maxCount) {
      result.unshift(s.slice(0, start));
      break;
    }
    const sepIndex = s.lastIndexOf(sep, start - 1);
    if (sepIndex < 0) {
      result.unshift(s.slice(0, start));
      break;
    }
    result.unshift(s.slice(sepIndex + 1, start));
    start = sepIndex;
  }
  return result;
}
