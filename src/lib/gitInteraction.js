import { basename, dirname } from 'path';
import CodedError, { ASSERT_ERROR } from './codedError.js';
import SeparatedRecordConsumer from './SeparatedRecordConsumer.js';
import { strrpart, ENDL_PATTERN as eolRegex } from './stringUtils.js';
import { normalizeOpts } from './toolInvocationHelpers.js';

export const sharedCasefilesRef = 'refs/collaboration/shared-casefiles';
export const gitLsTreeCasefileEntryRegex = /^(?<mode>\S+) (?<type>\S+) (?<hash>\S+)\t(?<cfPath>(?<cfName>.+)\/[^/]+)$/;
export const gitLsTreeEntryRegex = /^(?<mode>\S+) (?<type>\S+) (?<hash>\S+)\t(?<name>.+)$/s;
export const deletedCasefileCommitInfoRegex = /- (?<commit>\S+) (?<committed>\S+ \S+ \S+)/
export const gitEmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export { ASSERT_ERROR };

const DeletedCasefileListingStates = makeEnum('action path');

/**
 * @summary Class encapsulating usage of `git`
 * @memberof module:git-casefile/impl
 */
class GitInteraction {
  constructor({ runGitCommand }) {
    this.gitCommandRunner = runGitCommand;
  }
  
  async runGitCommand(command, {opts = {}, ...kwargs} = {}) {
    // Preprocess opts
    opts = normalizeOpts(opts);
    
    // Call raw handler
    return this.gitCommandRunner(command, {opts, ...kwargs});
  }
  
  /**
   * @summary Retrieve a list of configured Git remotes
   * @returns {Promise.<Array.<string>>} Remote names/aliases
   */
  async getListOfRemotes() {
    var remotes = [];
    return this.runGitCommand('remote', {
      operationDescription: 'list Git remotes',
      stdout: lineStream((name) => {
        remotes.push(name.trim());
      }),
      result: remotes,
    });
  }
  
  /**
   * @summary Fetch the current set of shared casefiles from the named remote
   * @param {string} remoteName - Name of remote to consult
   * @returns {Promise.<null>} No real return value
   */
  async fetchSharedCasefilesFromRemote(remoteName) {
    if (remoteName == null) {
      throw new TypeError(`remoteName must not be ${typeof remoteName}`);
    }
    return this.runGitCommand('fetch', {
      args: [remoteName, `+${sharedCasefilesRef}*:${sharedCasefilesRef}*`],
      operationDescription: `fetch shared casefiles ref from Git remote '${remoteName}'`,
      result: null,
    });
  }
  
  /**
   * @summary Get a list of casefiles known locally
   * @returns {Promise.<Array.<{name: string, instances: Array.<{path: string}>}>>}
   */
  async getListOfCasefiles() {
    const casefiles = [];
    const recordDecoder = new SeparatedRecordConsumer('\0')
      .setRecordEncoding('utf8')
      .on('record', (entry) => {
        const match = gitLsTreeCasefileEntryRegex.exec(entry);
        if (!match || match.groups.mode !== '100644' || match.groups.type !== 'blob') {
          return;
        }
        const prevCasefile = casefiles.slice(-1)[0] || {};
        const instance = {path: match.groups.cfPath};
        if (prevCasefile.name !== match.groups.cfName) {
          casefiles.push({name: match.groups.cfName, instances: [instance]});
        } else {
          prevCasefile.instances.push(instance);
        }
      })
      ;
    return this.runGitCommand('ls-tree', {
      opts: {'-': 'rz', 'full-tree': true},
      args: [sharedCasefilesRef],
      operationDescription: "list known, shared casefiles",
      stdout: recordDecoder,
      exit: code => code ? [] : casefiles,
    });
  }
  
  /**
   * @summary Get a list of all authors for a specified casefile instance
   * @param {string} path - Path of instance within the *sharedCasefilesRef*
   * @returns {Promise.<{path: string, authors: Array.<string>}>}
   */
  async getCasefileAuthors(path) {
    const authors = [];
    return this.runGitCommand('log', {
      opts: {pretty: 'format:%aN'},
      args: [sharedCasefilesRef, '--', path],
      operationDescription: `list authors of casefile group '${path}'`,
      stdout: lineStream((author) => {
        if (authors.indexOf(author) < 0) {
          authors.push(author);
        }
      }),
      makeResult: function() {
        authors.sort();
        return ({path, authors});
      },
    });
  }
  
  /**
   * @summary Retrieve the content of a casefile
   * @param {string} path - Path of casefile instance
   * @param {object} opts
   * @param {string} opts.beforeCommit - A latest, open bound on the commit to read
   * @returns {Promise.<Object>} Casefile data
   */
  async getCasefile(path, { beforeCommit } = {}) {
    const contentChunks = [];
    let commit = sharedCasefilesRef;
    if (beforeCommit) {
      commit = await this.findLatestCommitParentWithPath(path, beforeCommit);
    }
    return this.runGitCommand('cat-file', {
      args: ['blob', `${commit}:${path}`],
      operationDescription: `retrieve contents of casefile '${path}'`,
      stdout: (line) => {
        contentChunks.push(line);
      },
      makeResult: () => {
        let casefileData = JSON.parse(contentChunks.join(''));
        if (Array.isArray(casefileData)) {
          casefileData = { bookmarks: casefileData };
        }
        casefileData.path = path;
        return casefileData;
      },
    });
  }
  
  /**
   * @summary Retrieve the content of a blob from the repository
   * @param {string} path - Path of the blob within the committish tree
   * @param {object} [opts]
   * @param {string} [opts.commit] - The commit (or committish) from which to retrieve the blob
   * @returns {Promise.<string>} Blob contents
   */
  async getBlobContent(path, { commit = 'HEAD' } = {}) {
    let content = '';
    return this.runGitCommand('cat-file', {
      args: ['blob', `${commit}:${path}`],
      operationDescription: `retrieve contents of '${path}' from '${commit}'`,
      stdout: chunk => {
        content += chunk;
      },
      makeResult: () => content,
    });
  }
  
  /**
   * @private
   * @summary Given a path and commit, find the latest parent commit which includes the path
   * @param {string} path
   * @param {string} limitingCommit
   * @returns {Promise.<string | undefined>} A promise of the hash of the best-match commit
   */
  async findLatestCommitParentWithPath(path, limitingCommit) {
    const parents = [];
    await this.runGitCommand('rev-parse', {
      args: [limitingCommit + '^@'],
      operationDescription: `identify parents of ${limitingCommit}`,
      stdout: lineStream((parent) => { parents.push(parent); }),
      result: null,
    });
    const bestParent = await parents.map(
      commit => this.getDateOfLastChange(path, {commit}).then(
        date => [{commit, date}],
        (err) => {
          /* istanbul ignore next */
          if (err && err[ASSERT_ERROR]) throw err;
          return []
        }
      )
    ).reduce(
      (bestYetPromise, newDataPromise) => bestYetPromise.then(
        bestYet => newDataPromise.then(
          ([ newData ]) => (!newData || bestYet.date > newData.date) ? bestYet : newData
        )
      ),
      Promise.resolve({date: 0})
    );
    return bestParent.commit;
  }
  
  /**
   * @private
   * @summary Get the date at which a given path in the repository changed
   * @param {string} path - Path of a file in the respository
   * @param {object} [opts]
   * @param {string} [opts.commit='HEAD'] - Last commit to consider
   * @returns {Promise.<number>} Date at which *path* last changed (no later than *opts.commit*)
   *
   * @description
   * There is a certain amount of ambiguity as to the correctness of the answer.
   * Under normal circumstances, the answer will be reasonable and based on the
   * commit date.
   */
  async getDateOfLastChange(path, { commit = 'HEAD' } = {}) {
    let result = 0;
    return this.runGitCommand('log', {
      opts: {pretty: 'format:%ci', n: '1'},
      args: [commit, '--', path],
      operationDescription: `query date '${path}' last committed in ${commit}`,
      stdout: lineStream((line, endStream) => {
        result = new Date(line.trim()).getTime();
        endStream();
      }),
      makeResult: () => result,
    });
  }
  
  /**
   * @summary Fetch new Git objects from the named remote
   * @param {string} remote
   * @returns {Promise.<undefined>}
   */
  async fetchFromRemote(remote) {
    return this.runGitCommand('fetch', {
      args: [remote],
      operationDescription: `fetch remote '${remote}'`,
      result: null,
    });
  }
  
  /**
   * @summary Find commits that are not known by the stated remote
   * @param {string} remote - Name of remote to work with
   * @param {Array.<string>} commits - Commits to consider
   * @returns {Promise.<Array.<string>>} Commits not found in the history of any branch shared by *remote*
   *
   * @description
   * This method indirectly expects that the pull configuration for *remote*
   * behaves is the default way with regard to creating remote-tracking branches
   * in refs/remotes/REMOTE-NAME for a remote named REMOTE-NAME.
   */
  async selectCommitsUnknownToRemote(remote, commits) {
    let result = [];
    const parallel = 8;
    for (let i = 0; i * parallel < commits.length; ++i) {
      const workSlice = commits.slice(i * parallel, (i + 1) * parallel);
      const newResults = await Promise.all(workSlice.map(
        commit => (
          this.testIfCommitKnownToRemote(remote, commit)
            .then(commitKnown => commitKnown ? [] : [commit])
        )
      )).then(parts => parts.flat());
      result.push(...newResults);
    }
    return result;
  }
  
  /**
   * @private
   * @summary Test if one commit is known to a specific remote
   * @param {string} remote
   * @param {string} commit
   * @returns {Promise.<boolean>}
   */
  async testIfCommitKnownToRemote(remote, commit) {
    let outputReceived = false;
    return this.runGitCommand('branch', {
      opts: {'-': 'r', contains: commit},
      args: [`${remote}/*`],
      stdout: lineStream((line, endStream) => {
        outputReceived = true;
        endStream();
      }),
      makeResult: () => outputReceived,
    });
  }
  
  /**
   * @summary Share a casefile with the given remote repository
   * @param {string} remote
   * @param {string} path - Group-slash-instance to store under
   * @param {Array.<object>} bookmarks - JSON-serializable bookmark data
   * @returns {Promise.<{message: string, commit: ?string}>}
   */
  async shareCasefile(remote, path, bookmarks) {
    const parentCommits = [], [ group, instance ] = strrpart(path, '/', 2);
    let currentCasefilesTree = gitEmptyTree;
    let casefileHash = null, groupTreeHash;

    await this.revParse(sharedCasefilesRef).then(
      refCommit => {
        parentCommits.push(refCommit);
        currentCasefilesTree = refCommit;
      },
      (e) => {
        /* istanbul ignore next */
        if (e && e[ASSERT_ERROR]) throw e;
        return null;
      },
    );
    
    await this.getHashOfCasefile(bookmarks).then(hash => {
      casefileHash = hash;
    });
    
    const groupTreeEntries = await this.lsTree(
      `${currentCasefilesTree}:${group}`
    );
    
    const existingIndex = groupTreeEntries.findIndex(
      ({ name }) => name === instance
    );
    const newEntry = {
      mode: '100644',
      type: 'blob',
      hash: casefileHash,
      name: instance,
    };
    if (existingIndex < 0) {
      groupTreeEntries.push(newEntry);
    } else if (groupTreeEntries[existingIndex].hash === casefileHash) {
      return {message: "no changes to share", commit: currentCasefilesTree};
    } else {
      groupTreeEntries.splice(existingIndex, 1, newEntry);
    }
    groupTreeHash = await this.mktree(groupTreeEntries);
    let rootTreeEntries = await this.lsTree(currentCasefilesTree);
    rootTreeEntries = rootTreeEntries.filter(({ name }) => name !== group);
    rootTreeEntries.push({
      mode: '040000',
      type: 'tree',
      hash: groupTreeHash,
      name: group,
    });
    const newTree = await this.mktree(rootTreeEntries);
    const newCommit = await this.commitCasefilesTree(newTree, {
      parents: parentCommits,
      message: "Share casefile",
    });
    await this.push(remote, {
      source: newCommit,
      dest: sharedCasefilesRef,
    });
    await this.updateRef(sharedCasefilesRef, newCommit);
    return {message: "casefile shared", commit: newCommit};
  }
  
  /**
   * @summary Delete selected paths from the casefile set in a remote repository
   * @param {string} remote
   * @param {Array.<string>} paths
   */
  async deleteCasefilePaths(remote, paths) {
    const groups = new Map(), parentCommits = [];
    paths.forEach((p) => {
      const segments = strrpart(p, '/', 2);
      groups.set(segments[0], null);
    });
    let currentCasefilesTree = gitEmptyTree;
    
    await this.revParse(sharedCasefilesRef).then(
      refCommit => {
        parentCommits.push(refCommit);
        currentCasefilesTree = refCommit;
      },
      (err) => {
        /* istanbul ignore next */
        if (err[ASSERT_ERROR]) throw err;
        currentCasefilesTree = null;
      }
    );
    if (!currentCasefilesTree) {
      return;
    }
    let foundEntriesToRemove = false;
    await Promise.all(Array.from(groups.keys(), async (group) => {
      const entries = await this.lsTree(`${currentCasefilesTree}:${group}`)
        .catch(err => {
          /* istanbul ignore next */
          if (err[ASSERT_ERROR]) throw err;
          return null;
        });
      if (entries === null) {
        return;
      }
      
      // Remove any entries matching *paths*
      const remainingEntries = entries.filter(
        e => paths.indexOf(`${group}/${e.name}`) < 0
      );
      if (remainingEntries.length < entries.length) {
        foundEntriesToRemove = true;
      } else {
        groups.delete(group);
        return;
      }
      
      const groupTree = (
        // If some entries are left...
        remainingEntries.length > 0
        // Create tree (`git mktree`) for the revised group
        ? await this.mktree(remainingEntries)
        // Otherwise, associate null with the group
        : null
      );
      groups.set(group, groupTree);
    }));
    if (!foundEntriesToRemove) {
      return;
    }
    const rootEntries = await this.lsTree(currentCasefilesTree);
    const newRootEntries = rootEntries.flatMap(entry => {
      if (!groups.has(entry.name)) {
        return [entry];
      } else if (groups.get(entry.name) === null) {
        return [];
      } else {
        return [{
          mode: '040000',
          type: 'tree',
          hash: groups.get(entry.name),
          name: entry.name,
        }];
      }
    });
    const newCommit = (
      newRootEntries.length === 0
      ? ''
      : await this.commitCasefilesTree(
        await this.mktree(newRootEntries),
        {
          parents: parentCommits,
          message: "Delete casefile(s)",
        }
      )
    );
    await this.push(remote, {
      source: newCommit,
      dest: sharedCasefilesRef,
    });
    await this.updateRef(sharedCasefilesRef, newCommit);
  }
  
  /**
   * @summary Parse the given committish to find the hash to which it resolves
   * @param {string} committish
   * @returns {Promise.<string>} Commit hash
   * @throws {GitInterationError} (`err.code === 'InvalidCommittish'`)
   *   When Git returns an invalid result
   */
  async revParse(committish) {
    let result = null;
    return this.runGitCommand('rev-parse', {
      args: [committish],
      operationDescription: `resolve '${committish}' to a commit hash`,
      stdout: lineStream((line, endStream) => {
        result = line.trim();
        endStream();
      }),
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new GitInterationError({ code: 'InvalidCommittish' });
        }
        return result;
      }
    });
  }
  
  /**
   * @private
   * @summary Write a casefile as a blob to the repo and return the blob's hash
   * @param {Array.<object>} bookmarks - Bookmark content to be recorded
   * @returns {Promise.<string>} The commit hash of the recorded blob
   * @throws {GitInterationError} (`err.code === 'GitWriteFailed'`)
   *   When Git responds with an invalid result for writing the casefile into
   *   the repository
   */
  async getHashOfCasefile(bookmarks) {
    let result = null;
    return this.runGitCommand('hash-object', {
      opts: {'-': 'w', stdin: true},
      operationDescription: 'write casefile into Git blob',
      feedStdin: stdin => {
        stdin.write(JSON.stringify({bookmarks}));
      },
      stdout: lineStream((hash, endStream) => {
        result = hash.trim();
        endStream();
      }),
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new GitInterationError({ code: 'GitWriteFailed' });
        }
        return result;
      }
    });
  }
  
  /**
   * @private
   * @typedef {object} TreeEntry
   * @property {string} mode
   * @property {string} type
   * @property {string} hash
   * @property {string} name
   */
  
  /**
   * @summary List the contents of a Git tree
   * @param {string} treeish - A Git *tree-ish* value, often a reference to a commit
   * @returns {Promise.<Array.<TreeEntry>>}
   */
  async lsTree(treeish) {
    const treeEntries = [];
    const recordDecoder = new SeparatedRecordConsumer('\0')
      .setRecordEncoding('utf8')
      .on('record', (entry) => {
        const match = gitLsTreeEntryRegex.exec(entry);
        if (match) {
          treeEntries.push(match.groups);
        }
      })
      ;
    return this.runGitCommand('ls-tree', {
      opts: {'-': 'z', 'full-tree': true},
      args: [treeish],
      operationDescription: `list contents of '${treeish}'`,
      stdout: recordDecoder,
      exit: code => code ? [] : treeEntries,
    });
  }
  
  /**
   * @summary Create a tree object from a list of entries
   * @param {Array.<TreeEntry>} entries
   * @returns {Promise.<string>} Hash of tree
   * @throws {GitInterationError} (`err.code === 'InvalidTreeResult'`)
   *   When Git does not return a valid value
   */
  async mktree(entries) {
    const badEntries = entries.filter(entry => {
      if (entry.name.includes('/')) return 'bad';
    });
    if (badEntries.length !== 0) {
      throw new GitInterationError({ code: 'InvalidTreeEntry', badEntries });
    }
    let result = null;
    return this.runGitCommand('mktree', {
      opts: {'-': 'z'},
      operationDescription: 'build Git tree object',
      feedStdin: stdin => {
        entries.forEach(entry => {
          stdin.write(`${entry.mode} ${entry.type} ${entry.hash}\t${entry.name}\0`);
        });
      },
      stdout: lineStream((line, endStream) => {
        result = line.trim();
        endStream();
      }),
      makeResult: () => {
        if (!result || result.length === 0 || result === gitEmptyTree) {
          throw new GitInterationError({ code: 'InvalidTreeResult', result });
        }
        return result;
      },
    });
  }
  
  /**
   * @private
   * @summary Record a commit with shared casefiles
   * @param {string} tree - Hash identifying tree for the commit
   * @param {object} opts
   * @param {Array.<string>} [opt.parents=[]] - Parent commits
   * @param {string} opt.message
   * @returns {Promise.<string>} Hash of new commit
   * @throws {GitInterationError} (`err.code === 'InvalidCommit'`)
   *   When Git responds with an invalid commit hash
   */
  async commitCasefilesTree(tree, { parents = [], message } = {}) {
    const parentArgs = parents.flatMap(p => ['-p', p]);
    let result = null;
    return this.runGitCommand('commit-tree', {
      opts: {m: message},
      args: parentArgs.concat([tree]),
      operationDescription: `creating commit for tree ${tree}`,
      stdout: lineStream((line, endStream) => {
        result = line.trim();
        endStream();
      }),
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new GitInterationError({ code: 'InvalidCommit' });
        }
        return result;
      },
    });
  }
  
  /**
   * @private
   * @typedef {Object} PushSpec
   * @property {string} source
   *    Committish in the local repository
   * @property {string} dest
   *    Name pushed
   * @property {boolean} [force]
   *    Whether to force the push, even if not a fast-forward
   */

  /**
   * @summary Push a commit to a named reference on a remote
   * @param {string} remote
   * @param {...(PushSpec | string)} specs
   *    What to push
   * @returns {Promise.<null>}
   *
   * @description
   * This method pushes *specs* to *remote*; each item of *specs* can be
   * either a string (which serves as both source name and destination branch
   * name, and is *not* forced) or a {@link PushSpec} object.  This is similar
   * to the simple and full syntaxes of the command line `git push` command,
   * though use of {@link PushSpec} objects is recommended for clarity.
   */
  async push(remote, ...specs) {
    const specArgs = specs.map(spec => {
      if (typeof spec === 'string') {
        spec = { source: spec, dest: `refs/heads/${spec}` };
      }
      const { source, dest, force } = spec;
      return `${force ? '+' : ''}${source}:${dest}`;
    });
    
    const operationDescription = (function() {
      if (specs.length === 1) {
        const { source, dest, force } = specs[0];
        if (source && dest) {
          return `${force ? 'force ' : ''}push ${source} to ${dest} on ${remote}`;
        }
      }
      
      return `push ${specs.map(spec => spec?.source || spec).join(', ')} to ${remote}`;
    }());
    
    return this.runGitCommand('push', {
      args: [remote].concat(specArgs),
      operationDescription,
      result: null,
    });
  }
  
  /**
   * @summary Safely update a named reference in the repository
   * @param {string} refName
   * @param {string} commit - New value for *refName*
   * @returns {Promise.<null>}
   */
  async updateRef(refName, commit) {
    return this.runGitCommand('update-ref', {
      args: [refName, commit],
      operationDescription: `updating Git ref '${refName}' to ${commit}`,
      result: null,
    });
  }
  
  /**
   * @summary Look up information on deleted casefiles from the repo history
   * @param {string} [partial] - A substring found within the casefile group name
   * @returns {Promise.<Array.<{commit: string, committed: Date, path: string}>>}
   */
  async getDeletedCasefileRefs(partial) {
    const opts = {
      '-': 'z', // NUL-separate diff items
      'diff-filter': 'D', // Only list deleted files
      'name-status': true, // Only show file names, not patch
      pretty: 'format:- %H %ci', // Format the commit indication line as expected
    };
    const args = [];
    args.push(sharedCasefilesRef); // Search our special ref
    if (partial && partial.length > 0) {
      args.push('--', `*${partial}*/*`);
    }
    
    const deletedCasefiles = [], State = DeletedCasefileListingStates;
    let remainder = '', parseState = State.action, commitInfo = null;
    const recordDecoder = new SeparatedRecordConsumer('\0')
      .setRecordEncoding('utf8')
      .on('record', (rec) => {
        switch (parseState) {
          case State.action:
            if (rec.length === 0) {
              // Empty record before next commit in log
              break;
            }
            if (rec.startsWith('-')) {
              // The first line of rec is a commit info line
              const lineEnd = /\r?\n|\r/.exec(rec);
              if (!lineEnd) {
                throw new GitInterationError({ code: 'InvalidGitLogOutput' });
              }
              const ciRec = rec.slice(0, lineEnd.index);
              rec = rec.slice(lineEnd.index + lineEnd[0].length);
              
              // Process the commit info
              const match = deletedCasefileCommitInfoRegex.exec(ciRec);
              if (match) {
                commitInfo = match.groups;
              }
            }
            // Always rec === 'D'
            parseState = State.path;
            break;
          
          case State.path:
            // rec is path to add to deletedCasefiles
            deletedCasefiles.push({
              commit: commitInfo.commit,
              committed: new Date(commitInfo.committed),
              path: rec,
            });
            parseState = State.action;
            break;
        }
      })
      ;
    
    return this.runGitCommand('log', {
      opts,
      args,
      operationDescription: 'get a list of deleted casefiles',
      stdout: recordDecoder,
      exit: code => {
        if (!code) {
          return deletedCasefiles;
        } else {
          return [];
        }
      },
    });
  }
  
  /**
   * @summary Find the commit and line at which the given line was added to the file
   * @param {string} filePath
   *    The path to the file/blob within the repository whose history to search
   * @param {number} line
   *    The line number (1-based) within the reference content for *filePath*
   *    for whose introduction to search
   * @param {object} [opts]
   * @param {string} [opts.commit]
   *    Commit (or committish) with content for *filePath* in which to start the
   *    search
   * @param {string} [opts.liveContent]
   *    Current, unsaved content of *filePath*; has no effect when specified if
   *    *opts.commit* is also specified
   * @returns {Promise.<{commit: string, line: number}>}
   *    The commit and line at which *line* in the reference content was
   *    introduced into *filePath* in the repository
   * @throws {GitInterationError} (code === 'NoCommitFound')
   *    When no commit is reported by Git as the origin for *line* in *filePath*
   *
   * @description
   * This method searches within the repository to find the commit at which a
   * certain line was introduced into *filePath*, and the line number this
   * line had at the time it was introduced.
   *
   * The *reference content* to which *line* refers can come from one of three
   * options, given here in order of precedence:
   *
   * * If *opts.commit* is specified, the contents of *filePath* at
   *   *opts.commit* constitute the reference content.
   * * If *opts.liveContent* is specified, *opts.liveContent* is the reference
   *   content.
   * * Otherwise, the content of *filePath* on the disk is the reference
   *   content.
   */
  async lineIntroduction(filePath, line, { commit, liveContent } = {}) {
    const gitOpts = {
      L: `${line},${line}`,
      porcelain: true,
    };
    const gitArgs = [];
    const hasLiveContent = commit == null && liveContent !== undefined;
    if (commit != null) {
      gitArgs.push('' + commit);
    }
    gitArgs.push('--', basename(filePath));
    if (hasLiveContent) {
      gitOpts.contents = '-';
    }
    const result = {};
    return this.runGitCommand('blame', {
      opts: gitOpts,
      args: gitArgs,
      operationDescription: `find origin of line ${line} in '${filePath}'`,
      cwd: dirname(filePath),
      feedStdin: hasLiveContent ? (stdin) => {
        stdin.end('' + liveContent);
      } : undefined,
      stdout: lineStream((line, endStream) => {
        [ result.commit, result.line ] = line.split(' ');
        result.line = Number(result.line);
        if (result.commit.match(/^(?:0{40}|0{64})$/)) {
          delete result.commit;
        }
        endStream();
      }),
      exit: exitCode => {
        if (result.commit) {
          return result;
        }
        throw new GitInterationError({
          code: 'NoCommitFound',
          message: `No commit known for line ${line} of ${filePath}`,
          file: filePath,
          line,
          ...(exitCode === 0 ? {} : { exitCode }),
        });
      },
    });
  }
  
  /**
   * @summary Find the current line position from a historic line reference
   * @param {string} filePath
   *    The path to the file/blob within the repository whose history to search
   * @param {object} location
   * @param {string} location.commit
   *    The commit hash establishing the context for *location.line*
   * @param {number} location.line
   *    The line within *filePath* at commit *location.commit* for which to
   *    search within *content*
   * @param {string} [content]
   *    The current content in which to search; on-disk content of *filePath*
   *    used if not specified
   * @returns {Promise.<{line: number}>}
   */
  async findCurrentLinePosition(filePath, {commit, line}, content) {
    const soughtLine = Number(line);
    const commitLinePattern = new RegExp(
      `^${commit}\\S* (?<sourceline>\\d+) (?<resultline>\\d+) (?<span>\\d+)`
    );
    const gitOpts = { incremental: true };
    const contentGiven = content !== undefined;
    if (contentGiven) {
      gitOpts.contents = '-';
    }
    return new Promise((resolve, reject) => {
      this.runGitCommand('blame', {
        opts: gitOpts,
        args: [ '--', basename(filePath) ],
        operationDescription:
          `locate line ${line} from commit ${commit.slice(0, 7)}` +
          ` of ${filePath} in ${contentGiven ? 'given' : 'current'} content`,
        cwd: dirname(filePath),
        feedStdin: contentGiven ? (stdin) => {
          stdin.write('' + content);
        } : undefined,
        stdout: lineStream((line, endStream) => {
          const lineParts = (commitLinePattern.exec(line) || []).groups;
          if (!lineParts) return;
          
          for (const key in lineParts) {
            lineParts[key] = Number(lineParts[key]);
          }
          
          const { sourceline, resultline, span } = lineParts;
          if (sourceline <= soughtLine && soughtLine < sourceline + span) {
            resolve({ line: resultline + (soughtLine - sourceline) });
            endStream();
          }
        }),
        makeResult: () => {
          reject(new GitInterationError({
            code: 'LineNotFound',
            message:
            `Unable to find current location of line ${line}` +
            ` of ${filePath} from commit ${commit.slice(0, 7)}`,
            file: filePath,
            commit,
            line,
          }));
        },
      }).catch(reject);
    });
  }
}

const ERROR_MESSAGES_BY_CODE = {
  InvalidCommittish: "Invalid committish",
  GitWriteFailed: "Write failed (no hash returned)",
  InvalidTreeEntry: "Invalid entry(ies) for mktree",
  InvalidTreeResult: "Invalid mktree result",
  InvalidCommit: "Invalid commit hash from commit creation",
  InvalidGitLogOutput: "Output from git-log had unexpected format",
};

export class GitInterationError extends CodedError(ERROR_MESSAGES_BY_CODE) {}

/**
 * @private
 * @summary Create an enumeration object
 * @params {string} spaceSeparatedTerms - Enumerated names with spaces between
 * @returns {object} Enumeration object with a property for each name in *spaceSeparatedTerms*
 *
 * @description
 * Generates an object to represent an enueration of terms.  The resulting
 * object has properties only for the terms in *spaceSeparatedTerms*.
 *
 * It is possible to wrap the result in a Proxy to detect access to undefined
 * names as a debugging tool.
 */
function makeEnum(spaceSeparatedTerms) {
  const result = Object.create(null);
  spaceSeparatedTerms.split(/\s+/).forEach(s => {result[s] = s;});
  return result;
}

function lineStream(handler) {
  return new SeparatedRecordConsumer(eolRegex)
    .setRecordEncoding('utf8')
    .on('record', handler);
}

export default GitInteraction;
