
/**
 * @summary Interact with Git remote
 */
class GitRemote {
  constructor(gitOps, remote) {
    this.gitOps = gitOps;
    this.name = remote;
  }
  
  /**
   * @summary Fetch the casefiles from this remote to the local repository
   * @returns {Promise.<null>}
   */
  fetchSharedCasefiles() {
    return this.gitOps.fetchSharedCasefilesFromRemote(this.name);
  }
  
  /**
   * @summary Test if a casefile references commits unknown to this remote
   *
   * @param {Casefile} casefile
   *    Casefile with bookmarks to check against this remote
   * @returns {Promise.<(Array.<string> | false)>}
   *    Either `false` (if this remote knows all referenced commits) or an
   *    Array of the commits that are unknown; this result is "truthy" if
   *    commits are unknown and `false` if all are known
   *
   * @description
   * This method can be used prior to {@link .share} to determine
   * whether the shared casefile will reference unknown commits.  If the call to
   * this method returns an Array (i.e. not `false`), three options can be
   * offerred to the user: cancel the sharing of the casefile, push the unknown
   * commits (possibly to `refs/collaboration/referenced-commits/<COMMIT-HASH>`)
   * prior to sharing the casefile, or sharing the casefile despite the missing
   * referent commits.  A function implementing this logic would look like:
   *
   * ```
   * async function prepareSharing(remote, casefile, { userSelectedAction }) {
   *   const unshared = remote.commitsUnknown(casefile);
   *   if (unshared) {
   *     // Let the user decide action
   *     switch (userSelectedAction(unshared)) {
   *       case 'shareWithoutPush':
   *         return true;
   *       case 'cancel':
   *         return false;
   *       case 'pushAndShare':
   *         await remote.pushCommitRefs(...unshared);
   *         return true;
   *     }
   *   }
   *   return true;
   * }
   * ```
   *
   * The function above resolves `true` if the casefile should be shared (with
   * `remote.share(casefile)`) and `false` if not.
   *
   * This method only functions properly on a {@link Casefile} whose `bookmarks`
   * embody the {@link Bookmark} type, specifically with regard to `peg.commit`
   * and `children`.
   */ 
  async commitsUnknown(casefile) {
    const commits = await this.gitOps.selectCommitsUnknownToRemote(
      this.name,
      reduceBookmarkForestToCommits(casefile.bookmarks)
    );
    return commits.length ? commits : false;
  }
  
  /**
   * @summary Share a {@link Casefile} to this remote
   * @param {Casefile} casefile
   * @returns {Promise.<{message: string, commit: ?string}>}
   */
  share(casefile) {
    return this.gitOps.shareCasefile(
      this.name,
      casefile.path,
      casefile.bookmarks,
    );
  }
  
  /**
   * @summary Push some commits to unique names in this remote
   * @param {...string} commits
   * @returns {Promise.<null>}
   *
   * @description
   * This method gets all of *commits* to this remote, allowing bookmarks to
   * reference the commits even if they are not present in any other history
   * shared with the remote.
   *
   * This method should be used with care — and always in response to a user
   * prompt — since it could result in uploading significant history to this
   * remote.
   */
  async pushCommitRefs(...commits) {
    return this.gitOps.push(this.name, ...commits.map(
      commit => ({
        source: commit,
        dest: `refs/collaboration/referenced-commits/${commit}`,
        force: true,
      })
    ));
  }
  
  /**
   * @param {...(string | Casefile)} casefiles
   *    Casefiles — or full paths to casefiles — to delete from this remote
   * @returns {Promise.<null>}
   */ 
  delete(...casefiles) {
    return this.gitOps.deleteCasefilePaths(
      this.name,
      casefiles.map(casefile => (
        typeof casefile === 'string'
        ? casefile
        : casefile.path
      )),
    );
  }
}

function reduceBookmarkForestToCommits(bookmarks) {
  bookmarks = [...bookmarks];
  const commits = new Set(), bookmarksSeen = new Set();
  while (bookmarks.length) {
    const bookmark = bookmarks.shift();
    if (bookmark?.children?.length) {
      for (const child of bookmark.children) {
        if (bookmarksSeen.has(child)) continue;
        bookmarks.push(child);
        bookmarksSeen.add(child);
      }
    }
    const markCommit = bookmark?.peg?.commit;
    if (markCommit) {
      commits.add(markCommit);
    }
  }
  return [...commits];
}

export default GitRemote;
