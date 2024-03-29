
/**
 * @typedef {Object} Casefile
 *
 * @property {?string} path
 * @property {Array.<Bookmark>} bookmarks
 */

/**
 * @summary Reference to a group of shared/saved casefiles
 *
 * @property {string} name
 * @property {Array.<CasefileRef>} instances
 */
export class CasefileGroup {
  constructor(gitOps, groupName, instances) {
    this.name = groupName;
    this.instances = instances.map(
      ({ path }) => new CasefileRef(gitOps, groupName, path)
    );
  }
}

/**
 * @summary Reference to a shared/saved casefile
 *
 * @property {string} path
 *
 * @description
 * Objects of this type reference a stored casefile which has been fetched
 * from a Git remote repository.  The only guarantees made about successfully
 * [load]{@link CasefileRef#load}ed casefiles are:
 *
 *    * The stored casefile is valid JSON.
 *    * The `path` property is set to the path of this instance.
 */
export class CasefileRef {
  constructor(gitOps, groupName, path) {
    this.gitOps = gitOps;
    this.groupName = groupName;
    this.path = path;
  }
  
  /**
   * @summary Get authors who contributed to the referenced casefile
   * @returns {Promise.<Array.<string>>}
   */
  async getAuthors() {
    return this.gitOps.getCasefileAuthors(this.path).then(
      ({ authors }) => authors
    );
  }
  
  /**
   * @summary Load the casefile contents from the repository
   * @returns {Promise.<(Casefile | object)>}
   */
  async load() {
    return this.gitOps.getCasefile(this.path);
  }
}

/**
 * @summary Reference to a previously shared casefile, now deleted
 */
export class DeletedCasefileRef {
  constructor(gitOps, { commit, committed, path }) {
    this.gitOps = gitOps;
    this.deletionCommit = commit;
    this.committed = committed;
    this.path = path;
  }
  
  /**
   * @summary Get authors who contributed to the referenced casefile
   * @returns {Promise.<Array.<string>>}
   */
  async getAuthors() {
    return this.gitOps.getCasefileAuthors(this.path).then(
      ({ authors }) => authors
    );
  }
  
  /**
   * @summary Load the casefile contents from the repository history
   * @returns {Promise.<object>}
   */
  async retrieve() {
    return this.gitOps.getCasefile(this.path, {
      beforeCommit: this.deletionCommit
    });
  }
}
