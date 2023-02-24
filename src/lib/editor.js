import fs from 'fs/promises';
import path from 'path';
import { ENDL_PATTERN } from './stringUtils.js';

/**
 * Interface for classes that represent editors that might have a file's
 * contents open (i.e. live)
 *
 * @interface Editor
 */

/**
 * @method
 * @name Editor#open
 * @param {string} filePath
 * @returns {EditBuffer}
 */

/**
 * @method
 * @name Editor#liveContent
 * @param {string} filePath
 * @returns {Promise.<(string | undefined)>}
 */

/**
 * @interface EditBuffer
 */

/**
 * @method
 * @name EditBuffer#lineText
 * @param {number} lnum (1-based) Number of line text to retrieve
 * @returns {(string | undefined)} Text content of line *lnum*
 */

/**
 * @summary Implements the Editor interface by saying no file is live
 * @implements {Editor}
 */
/* istanbul ignore next - not used in real tools */
export class NoEditor {
  constructor({ cwd }) {
    this.cwd = cwd;
  }
  
  async liveContent() {}
  
  async open(filePath) {
    if (this.cwd) {
      filePath = path.resolve(this.cwd, filePath);
    }
    const lines = await fs.readFile(filePath, { encoding: 'utf8' }).then(
      content => content.split(ENDL_PATTERN)
    );
    return {
      lineText: (lnum) => lines[Math.floor(lnum) - 1],
    };
  }
}
