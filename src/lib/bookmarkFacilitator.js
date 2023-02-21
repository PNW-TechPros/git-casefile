import CommandRunner from './commandRunner.js';
import DiffInteraction from './diffInteraction.js';
import { NoEditor } from './editor.js';
import GitInteraction from './gitInteraction.js';

const UNTRACKED_WINDOW_SIZE = 15;

class MarkNotFound extends Error {
  constructor(props) {
    super();
    Object.assign(this, props);
  }
}

/**
 * @typedef {Object} Bookmark
 *
 * @property {string} file
 *    Path within the project to the file
 * @property {number} line
 *    Line number (1-based) in file when bookmark was constructed
 * @property {string} text
 *    Text marked by bookmark
 * @property {Array.<Bookmark>} [children]
 *    Child bookmarks
 * @property {object} [peg]
 *    Persistent location identity within Git repository
 * @property {string} peg.commit
 *    Commit in which bookmarked line exists
 * @property {number} peg.line
 *    Line number within *peg.commit* version of *file*
 */

/**
 * @summary Class implementing bookmark-related operations
 *
 * @property {Logger} logger
 *    Logger used for error and warning messages
 * @property {Editor} editor
 *    Editor integration object, providing access to unsaved file content
 * @property {GitInteraction} gitOps
 *    Used to execute `git` commands
 * @property {DiffInteraction} diffOps
 *    Used to execute `diff`
 */
class BookmarkFacilitator {
  /**
   * Construct an instance
   *
   * @param {object} [kwargs]
   * @param {Editor} [kwargs.editor]
   *    Object used for interacting with the conceptual editor that might hold
   *    live changes to a given file in the working tree
   * @param {GitInteraction} [kwargs.gitOps]
   *    Alternate implementation of Git operations
   * @param {ToolkitRunnerFunc} [kwargs.runGitCommand]
   *    Alternate command runner for executing `git` program used to construct
   *    a {@link GitInteraction} object if *kwargs.gitOps* is not given
   * @param {DiffInteraction} [kwargs.diffOps]
   *    Alternate implementation of diff operations
   * @param {CommandRunnerFunc} [kwargs.runDiffCommand]
   *    Alternate command runner for executing `diff` program used to construct
   *    a {@link DiffInteraction} object if *kwargs.diffOps* is not given
   * @param {object} [kwargs.toolOptions={}]
   *    Tool options passed to {@link CommandRunner}, used if functions for
   *    invoking `git` or `diff` are needed
   * @param {Logger} [kwargs.logger=console]
   *    A `console`-like object used for logging warnings and errors
   *
   * @description
   * A BookmarkFacilitator needs a {@link GitInteraction} and a
   * {@link DiffInteraction} for carrying out its various methods.  If these
   * are not provided in the *kwargs.gitOps* and *kwargs.diffOps* parameters,
   * they will be constructed from the parameters that are provided.
   *
   * Construction of a {@link GitInteraction} requires a `runGitCommand`
   * which, if not provided in *kwargs.runGitCommand*, is constructed based
   * on *kwargs.toolOptions* (though passing `usesSubcommands` as `true`).
   * Similarly, construction of a {@link DiffInteraction} requires a
   * `runDiffCommand` which, if not provided in *kwargs.runDiffCommand*,
   * is constructed based on *kwargs.toolOptions* (though passing
   * `usesSubcommands` as `false`).
   */
  constructor({ editor, gitOps, runGitCommand, diffOps, runDiffCommand, toolOptions = {}, logger = console } = {}) {
    this.logger = logger;
    this.editor = editor || new NoEditor();
    this.gitOps = gitOps || new GitInteraction({
      runGitCommand: runGitCommand || CommandRunner('git', {
        ...toolOptions,
        usesSubcommands: true,
      }),
    });
    this.diffOps = diffOps || new DiffInteraction({
      runDiffCommand: runDiffCommand || CommandRunner('diff', {
        ...toolOptions,
        usesSubcommands: false,
      }),
    });
  }
  
  /**
   * @summary Find the location of a bookmark in the current file content
   *
   * @param {Bookmark} bookmark
   *    Bookmark whose current location to determine
   * @returns {Promise.<{file: string, line: number, col: number}>}
   */
  async currentLocation({file: filePath, line, markText: text, peg: gitPeg}) {
    const editBuffer = await this.editor.open(filePath);
    
    const rowHasText = (i) => {
      const lineText = editBuffer.lineText(i);
      return lineText && lineText.includes(text);
    };
    
    return new Promise((resolve, reject) => {
      const findAndReportTextInRow = (i) => {
        if (rowHasText(i)) {
          return resolve({
            file: filePath,
            line: i,
            col: editBuffer.lineText(i).indexOf(text) + 1,
          }) || true;
        }
      };
      
      const reportMarkLocationWithoutTracking = () => {
        if (!findAndReportTextInRow(line)) {
          for (let i = 1; i <= UNTRACKED_WINDOW_SIZE; ++i) {
            if (findAndReportTextInRow(line + i) || findAndReportTextInRow(line - i)) {
              return;
            }
          }
        }
      };
      
      if (gitPeg) {
        return this.retrieveBlameMatchLine(filePath, gitPeg)
          .then(({ line }) => {
            let val;
            val = findAndReportTextInRow(line);
            if (!val) {
              this.logger.warn(`blame was wrong, text %o not in line %d`, text, line);
              throw new MarkNotFound({ file: filePath, line, markText: text });
            }
          })
          .catch((e) => {
            if (!(e instanceof MarkNotFound) && !(e && e.code === 'LineNotFound')) {
              this.logger.error(e);
            }
            return this.computeCurrentLineRange(filePath, gitPeg)
            .then(({ start, prime, end }) => {
              if (findAndReportTextInRow(prime)) return;
              const iLimit = Math.max(prime - start, end - prime);
              for (let i = 1; i <= iLimit; ++i) {
                if (start <= prime - i && findAndReportTextInRow(prime - i)) return;
                if (prime + i < end && findAndReportTextInRow(prime + i)) return;
              }
              throw new MarkNotFound({ file: filePath, start, end });
            })
          })
          .catch((e) => {
            if (!(e instanceof MarkNotFound)) {
              this.logger.error(e);
            }
            reportMarkLocationWithoutTracking(e);
          })
          .finally(() => {
            reject(new MarkNotFound({ file: filePath, line, markText: text }));
          })
          ;
      }
      
      reportMarkLocationWithoutTracking();
      reject(new MarkNotFound({ file: filePath, line, markText: text }));
    });
  }
  
  /**
   * @summary Compute *peg* for bookmark
   *
   * @param {string} filePath
   *    Path of file
   * @param {number} currentLine
   *    Line (1-based) of file
   * @param {object} [kwargs]
   * @param {string} [kwargs.commit]
   *    Start point for the search
   * @returns {Promise.<{ line: number, commit: ?string }>}
   */
  async computeLinePeg(filePath, currentLine, {commit=null}={}) {
    // Try to get result via 'git blame'
    try {
      return await this.gitOps.lineIntroduction(
        filePath,
        currentLine,
        { commit, liveContent: await this.editor.liveContent(filePath) }
      );
    } catch (e) {
      // Continue on in this function
    }
    
    const promiseOfCommit = commit ? Promise.resolve(commit) : this.gitOps.revParse('HEAD');
    
    let promiseOfCurrentContent = this.editor.liveContent(filePath).then(
      content => (
        content == null
        ? { path: filePath }
        : { immediate: content }
      )
    );
    
    let promiseOfBaseContent = this.gitOps.getBlobContent(filePath, { commit })
      .then(content => ({ immediate: content }));
    
    try {
      const [ commit, baseContent, currentContent ] = await Promise.all(
        [ promiseOfCommit, promiseOfBaseContent, promiseOfCurrentContent ]
      );
      
      const hunks = await this.diffOps.getHunks(baseContent, currentContent);
      
      let currentOffset = 0;
      for (const hunk of hunks) {
        if (currentLine < hunk.currentStart) {
          return { line: currentLine - currentOffset };
        } else if (hunk.currentStart <= currentLine && currentLine < hunk.currentEnd) {
          return {
            line: Math.floor(
              (currentLine - hunk.currentStart) / (hunk.currentEnd - hunk.currentStart) * (hunk.baseEnd - hunk.baseStart)
            ) + hunk.baseStart,
            commit,
          };
        }
        currentOffset = hunk.currentEnd - hunk.baseEnd;
      }
      return { line: currentLine - currentOffset, commit };
    } catch (e) {
      return { line: currentLine };
    }
  }
  
  /**
   * @private
   * @returns {Promise.<{line: number}>}
   */
  async retrieveBlameMatchLine(filePath, {commit, line}) {
    const content = await this.editor.liveContent(filePath);
    return this.gitOps.findCurrentLinePosition(filePath, {commit, line}, content);
  }
  
  /**
   * @private
   * @returns {Promise.<{ start: number, prime: number, end: number }>}
   */
  async computeCurrentLineRange(filePath, {line, commit}) {
    line = Number(line);
    /* istanbul ignore if (method only called when git peg is pressent) */
    if (!commit) {
      return {start: line, prime: line, end: line + 1};
    }
    
    try {
      const liveContent = await this.editor.liveContent(filePath);
      const hunks = await this.diffOps.getHunks(
        { immediate: await this.gitOps.getBlobContent(filePath, { commit }) },
        liveContent == null ? { path: filePath } : { immediate: liveContent }
      );
      
      let currentOffset = 0;
      for (const hunk of hunks) {
        if (line < hunk.baseStart) {
          return {
            start: line + currentOffset,
            prime: line + currentOffset,
            end: line + currentOffset + 1,
          };
        } else if (hunk.baseStart <= line && line < hunk.baseEnd) {
          return {
            start: hunk.currentStart,
            prime: hunk.currentStart + Math.floor(
              (line - hunk.baseStart) / (hunk.baseEnd - hunk.baseStart) * (hunk.currentEnd - hunk.currentStart)
            ),
            end: hunk.currentEnd,
          };
        } else if (hunk.baseStart == line) {
          return {
            start: hunk.currentStart,
            prime: Math.floor((hunk.currentStart + hunk.currentEnd) / 2),
            end: hunk.currentEnd,
          };
        }
        currentOffset = hunk.currentEnd - hunk.baseEnd;
      }
      
      return {
        start: line + currentOffset,
        prime: line + currentOffset,
        end: line + currentOffset + 1,
      };
    } catch (e) {
      return {
        start: line,
        prime: line,
        end: line + 1,
      };
    }
  }
}

export default BookmarkFacilitator;
