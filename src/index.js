/**
 * @module git-casefile
 */
import BookmarkFacilitator from './lib/bookmarkFacilitator.js';
import { CasefileGroup, DeletedCasefileRef } from './lib/casefile.js';
import CommandRunner from './lib/commandRunner.js';
import GitInteraction from './lib/gitInteraction.js';
import GitRemote from './lib/gitRemote.js';

/**
 * @summary Class for managing casefiles
 *
 * @property {BookmarkFacilitator} bookmarks
 * @property {GitInteraction} gitOps
 *
 * @description
 * Use an instance of this class to both manage bookmark instances (through
 * its *bookmarks* property) and to access the shared casefile library(ies)
 * of configured remotes.
 *
 * While casefiles shared to remotes are generally expected to conform to the
 * {@link Casefile} type, there is no requirement they do so...only that they
 * are Objects supporting `JSON.stringify`.
 */
export class CasefileKeeper {
  /**
   * @summary Construct an instance of this class
   * @param {object} [kwargs]
   *    Keyword arguments; passed through to construct a {@link BookmarkFacilitator}
   * @param {GitInteraction} [kwargs.gitOps]
   *    Alternate implementation of Git operations
   * @param {ToolkitRunnerFunc} [kwargs.runGitCommand]
   *    Alternate command runner for executing `git` program used to construct
   *    a {@link GitInteraction} object if *kwargs.gitOps* is not given
   * @param {object} [kwargs.toolOptions]
   *    Options used to construct a {@link ToolkitRunnerFunc} for `git` if
   *    neither *kwargs.gitOps* nor *kwargs.runGitCommand* are given
   */
  constructor(kwargs = {}) {
    this.gitOps = kwargs.gitOps || new GitInteraction({
      runGitCommand: kwargs.runGitCommand || CommandRunner('git', {
        ...kwargs.toolOptions,
        usesSubcommands: true,
      }),
    });
    this.bookmarks = new BookmarkFacilitator({
      ...kwargs,
      gitOps: this.gitOps,
    });
  }
  
  /**
   * @summary Get a {@link GitRemote} for a given name
   * @param {string} name - Name of the remote
   * @returns {GitRemote} A new GitRemote object for *name*
   */
  remote(name) {
    return new GitRemote(this.gitOps, name);
  }
  
  /**
   * @summary Get an Array of {@link GitRemote} objects for all configured remotes
   * @returns {Promise.<Array.<GitRemote>>}
   */
  async getRemotes() {
    const remoteNames = await this.gitOps.getListOfRemotes();
    return remoteNames.map(name => new GitRemote(this.gitOps, name));
  }
  
  /**
   * @summary Get CasefileGroup objects for known casefiles
   * @returns {Promise.<Array.<CasefileGroup>>}
   */
  async getCasefiles() {
    const casefiles = await this.gitOps.getListOfCasefiles();
    return casefiles.map(cf => new CasefileGroup(
      this.gitOps,
      cf.name,
      cf.instances,
    ));
  }
  
  /**
   * @summary Get references to deleted casefiles (possibly filtered)
   *
   * @param {string} [partial]
   * @returns {Promise.<Array.<DeletedCasefileRef>>}
   */
  async getDeletedCasefileRefs(partial) {
    const refs = await this.gitOps.getDeletedCasefileRefs(partial);
    return refs.map(ref => new DeletedCasefileRef(this.gitOps, ref));
  }
}
