import fsPromises from 'fs/promises';
import { temporaryWrite } from 'tempy';
import CodedError from './codedError.js';
import Janitor from './janitor.js';
import SeparatedRecordConsumer from './SeparatedRecordConsumer.js';
import { splitIntoLines, ENDL_PATTERN } from './stringUtils.js';

export const ASSERT_ERROR = Symbol('assert error');

const hunkMapping = /^@@\s*-?(\d+)(?:,(\d+))?\s+\+?(\d+)(?:,(\d+))?/;

export default class DiffInteraction {
  constructor({ runDiffCommand }) {
    this.diffCommandRunner = runDiffCommand;
  }
  
  async runDiffCommand({opts = {}, ...kwargs} = {}) {
    const origOpts = opts;
    opts = {};
    for (var [ key, value ] of Object.entries(origOpts)) {
      if (key === '-') {
        for (let ch of value) {
          opts[ch] = true;
        }
      } else {
        opts[key] = value;
      }
    }
    
    return this.diffCommandRunner({opts, ...kwargs});
  }
  
  /**
   * @typedef {object} OnDiskContent
   * @summary Indicate content stored on the disk
   * @property {string} path - Path to the file containing the content
   */
  
  /**
   * @typedef {object} ImmediateContent
   * @summary Provide content as a string
   * @property {string} immediate - The text to process
   */
  
  /**
   * @typedef {(OnDiskContent | ImmediateContent)} TextContent
   */
  
  /**
   * @typedef {object} Change
   * @summary Range of 1-based line numbers in both sides of a diff representing a change
   *
   * @property {number} baseStart
   *    1-based line number in base version to delete or before which to insert
   * @property {number} baseEnd
   *    1-based line number of the first line *not* to delete; for pure
   *    insertion, this equals *baseStart*
   * @property {number} currentStart
   *    1-based line number in current version to add or mark position of
   *    deletion
   * @property {number} currentEnd
   *    1-based line number in current version marking the first line *not* to
   *    insert; for pure deletion, this equals *currentStart*
   */
  
  /**
   * @summary Get line number ranges of hunks that change between two text versions
   * @param {TextContent} baseContent
   * @param {TextContent} currentContent
   * @returns {Array.<Change>}
   *
   * @description
   * Invoke `diff` to compute line-based hunks that change from a base version
   * to a current version.  The content for a version may be provided either
   * as a path to a file already on disk or as an immediate string; when an
   * immediate string is provided, it is saved to a temporary file so that
   * two files paths can be provided for invoking `diff`.
   */
  async getHunks(baseContent, currentContent) {
    const janitor = new Janitor();
    try {
      const [ basePath, currentPath ] = await Promise.all(
        [baseContent, currentContent].map(c => this._getPath(c, janitor))
      );
      
      const hunks = [];
      return await this.runDiffCommand({
        opts: { U: 0 },
        args: [ basePath, currentPath ],
        stdout: new SeparatedRecordConsumer(ENDL_PATTERN).on('record', (line) => {
          const parts = hunkMapping.exec(line);
          if (!parts) return;
          const newHunk = {
            baseStart: parseInt(parts[1]),
            baseEnd: parseInt(parts[1]) + parseInt(parts[2] || "1"),
            currentStart: parseInt(parts[3]),
            currentEnd: parseInt(parts[3]) + parseInt(parts[4] || "1"),
          };
          if (parts[2] == "0") {
            newHunk.baseStart = newHunk.baseEnd = newHunk.baseStart + 1;
          }
          if (parts[4] == "0") {
            newHunk.currentStart = newHunk.currentEnd = newHunk.currentStart + 1;
          }
          hunks.push(newHunk);
        }),
        exit: exitCode => {
          if (exitCode === 0 || exitCode === 1) {
            return hunks;
          } else {
            const error = new DiffInteractionError({
              code: 'DiffFailure',
              message: "'diff' between base and current failed",
              base: contentDesc(baseContent),
              current: contentDesc(currentContent),
              exitCode,
            });
            throw error;
          }
        },
      });
    } finally {
      await janitor.cleanUpAsync();
    }
  }
  
  async _getPath(content, janitor) {
    if (content.path) {
      return content.path;
    }
    if (content.immediate) {
      const filePath = await temporaryWrite(content.immediate);
      janitor.addTask(() => fsPromises.rm(filePath, {force: true}));
      return filePath;
    }
    throw new DiffInteractionError({
      code: 'UnknownContentType',
      contentKeys: Object.keys(content),
    });
  }
}

function contentDesc(content) {
  if (content.path) {
    return { path: content.path };
  }
  if (content.immediate) {
    return { immediate: '...' };
  }
  /* istanbul ignore next */
  return Object.keys(content);
}

const ERROR_MESSAGES_BY_CODE = {
  DiffFailure: "The diff command failed",
  UnknownContentType: "The content source is of an unknown type (expected 'path' or 'immediate')",
};

export class DiffInteractionError extends CodedError(ERROR_MESSAGES_BY_CODE) {}
