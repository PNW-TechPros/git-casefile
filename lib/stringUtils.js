export const ENDL_PATTERN = /\r?\n|\r/;
const MAYBE_ENDL_AT_END_PATTERN = new RegExp(`(?:${ENDL_PATTERN.source})?$`);

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
