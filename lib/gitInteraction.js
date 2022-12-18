export const sharedCasefilesRef = 'refs/collaboration/shared-casefiles';
export const gitLsTreeCasefileEntryRegex = /^(?<mode>\S+) (?<type>\S+) (?<hash>\S+)\t(?<cfPath>(?<cfName>.+)\/[^/]+)$/;
export const gitLsTreeEntryRegex = /^(?<mode>\S+) (?<type>\S+) (?<hash>\S+)\t(?<name>.+)$/s;
export const deletedCasefileCommitInfoRegex = /- (?<commit>\S+) (?<committed>\S+ \S+ \S+)/;
export const gitEmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const ASSERT_ERROR = Symbol('assert error');

const DeletedCasefileListingStates = makeEnum('action path');

export default class GitInteraction {
  constructor({ runGitCommand }) {
    this.gitCommandRunner = runGitCommand;
  }
  
  async runGitCommand(command, {opts = {}, ...kwargs} = {}) {
    // Preprocess opts
    const origOpts = opts;
    opts = {};
    for (let [ key, value ] of Object.entries(origOpts)) {
      if (key === '-') {
        // Single letter, non-value options
        for (let ch of value) {
          opts[ch] = true;
        }
      } else {
        opts[key] = value;
      }
    }
    
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
      stdout: function(remoteNames) {
        const names = remoteNames.trim().split('\n').map(n => n.trim());
        remotes.push(...names);
      },
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
   * @returns {Promise.<{name: string, instances: Array.<{path: string}>}>}
   */
  async getListOfCasefiles() {
    const treeEntries = new NTEAccumulator();
    return this.runGitCommand('ls-tree', {
      opts: {'-': 'rz', 'full-tree': true},
      args: [sharedCasefilesRef],
      operationDescription: "list known, shared casefiles",
      stdout: treeEntries.accumulate,
      exit: code => {
        if (!code) {
          const casefiles = [];
          treeEntries.forEach(entry => {
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
          });
          return casefiles;
        } else {
          return [];
        }
      }
    });
  }
  
  /**
   * @summary Get a list of all authors for a specified casefile instance
   * @param {string} path - Path of instance within the *sharedCasefilesRef*
   * @returns {Promise.<{path: string, authors: Array.<string>}>}
   */
  async getAuthors(path) {
    const authors = [];
    return this.runGitCommand('log', {
      opts: {pretty: 'format:%aN'},
      args: [sharedCasefilesRef, '--', path],
      operationDescription: `list authors of casefile group '${path}'`,
      stdout: newAuthors => {
        splitIntoLines(newAuthors).forEach(author => {
          if (authors.indexOf(author) < 0) {
            authors.push(author);
          }
        });
      },
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
   * @returns {Array.<string>} File contents
   */
  async getContentLines(path, { beforeCommit } = {}) {
    const contentLines = [];
    let commit = sharedCasefilesRef;
    if (beforeCommit) {
      commit = await this.findLatestCommitParentWithPath(path, beforeCommit);
    }
    return this.runGitCommand('show', {
      args: [`${commit}:${path}`],
      operationDescription: `retrieve contents of casefile '${path}'`,
      stdout: chunk => {
        contentLines.push(...splitIntoLines(chunk));
      },
      result: contentLines,
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
      stdout: chunk => {
        parents.push(...splitIntoLines(chunk));
      },
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
      stdout: chunk => {
        result = new Date(chunk.trim()).getTime();
      },
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
      stdout: () => {
        outputReceived = true;
      },
      makeResult: () => outputReceived,
    });
  }
  
  /**
   * @summary Share a casefile with the given remote repository
   * @param {string} remote
   * @param {string} path - Group-slash-instance to store under
   * @param {Array.<object>} bookmarks - JSON-serializable bookmark data
   * @returns {Promise.<{message: string, commit: string?}>}
   * @throws {CasefileAlreadyShared} If sharing would produce no change
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
   * @throws {ExtendedError} (`err.code === 'InvalidCommittish'`)
   *   When Git returns an invalid result
   */
  async revParse(committish) {
    let result = null;
    return this.runGitCommand('rev-parse', {
      args: [committish],
      operationDescription: `resolve '${committish}' to a commit hash`,
      stdout: output => {
        result = output.trim();
      },
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new ExtendedError({ code: 'InvalidCommittish' });
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
   * @throws {ExtendedError} (`err.code === 'GitWriteFailed'`)
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
      stdout: hash => {
        result = hash.trim();
      },
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new ExtendedError({ code: 'GitWriteFailed' });
        }
        return result;
      }
    });
  }
  
  /**
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
    const treeEntries = new NTEAccumulator();
    return this.runGitCommand('ls-tree', {
      opts: {'-': 'z', 'full-tree': true},
      args: [treeish],
      operationDescription: `list contents of '${treeish}'`,
      stdout: treeEntries.accumulate,
      exit: code => {
        if (!code) {
          return treeEntries.flatMap(entry => {
            const match = gitLsTreeEntryRegex.exec(entry);
            return match ? [match.groups] : [];
          });
        } else {
          return [];
        }
      },
    });
  }
  
  /**
   * @summary Create a tree object from a list of entries
   * @param {Array.<TreeEntry>} entries
   * @returns {Promise.<string>} Hash of tree
   * @throws {ExtendedError} (`err.code === 'InvalidTreeResult'`)
   *   When Git does not return a valid value
   */
  async mktree(entries) {
    const badEntries = entries.filter(entry => {
      if (entry.name.includes('/')) return 'bad';
    });
    if (badEntries.length !== 0) {
      throw new ExtendedError({ code: 'InvalidTreeEntry', badEntries });
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
      stdout: output => {
        result = output.trim();
      },
      makeResult: () => {
        if (!result || result.length === 0 || result === gitEmptyTree) {
          throw new ExtendedError({ code: 'InvalidTreeResult', result });
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
   * @returns {string} Hash of new commit
   * @throws {ExtendedError} (`err.code === 'InvalidCommit'`)
   *   When Git responds with an invalid commit hash
   */
  async commitCasefilesTree(tree, { parents = [], message } = {}) {
    const parentArgs = parents.flatMap(p => ['-p', p]);
    let result = null;
    return this.runGitCommand('commit-tree', {
      opts: {m: message},
      args: parentArgs.concat([tree]),
      operationDescription: `creating commit for tree ${tree}`,
      stdout: (hash) => {
        result = hash.trim();
      },
      makeResult: () => {
        if (!result || result.length === 0) {
          throw new ExtendedError({ code: 'InvalidCommit' });
        }
        return result;
      },
    });
  }
  
  /**
   * @summary Push a commit to a named reference on a remote
   * @param {string} remote
   * @param {object} params
   * @param {string} params.source - Committish in the local repository
   * @param {string} params.dest - Name on *remote* to which *params.source* should be pushed
   * @param {boolean} [params.force=false] - Whether to force the push
   * @returns {Promise.<null>}
   */
  async push(remote, { source, dest, force }) {
    return this.runGitCommand('push', {
      args: [remote, `${force ? '+' : ''}${source}:${dest}`],
      operationDescription: `${force ? 'force ' : ''}push ${source} to ${dest} on ${remote}`,
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
   * @param {string} partial - A substring found within the casefile group name
   * @returns {Promise.<Array.<{commit: string, committed: string, path: string}>>}
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
    
    return this.runGitCommand('log', {
      opts,
      args,
      operationDescription: 'get a list of deleted casefiles',
      stdout: chunk => {
        remainder = forEachNTE(remainder + chunk, rec => {
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
                  throw new ExtendedError({ code: 'InvalidGitLogOutput' });
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
                committed: commitInfo.committed,
                path: rec
              });
              parseState = State.action;
              break;
          }
        });
      },
      exit: code => {
        if (!code) {
          return deletedCasefiles;
        } else {
          return [];
        }
      },
    });
  }
}

/**
 * @property {string} [code] - Programmatically recognizable identifier of error
 */
export class ExtendedError extends Error {
  static STANDARD_MESSAGES = {
    InvalidCommittish: "Invalid committish",
    GitWriteFailed: "Write failed (no hash returned)",
    InvalidTreeEntry: "Invalid entry(ies) for mktree",
    InvalidTreeResult: "Invalid mktree result",
    InvalidCommit: "Invalid commit hash from commit creation",
    InvalidGitLogOutput: "Output from git-log had unexpected format",
  };
  
  /**
   * @summary Construction of an instance
   * @param {object} props
   * @param {string} [props.message] - Explicit message for error
   * @param {string} [props.code] - Progammatically recognizable identifier of error
   *
   * @description
   * Except for *props.message*, all *props* passed are assigned to the
   * constructed instance.  If a recognized *props.code* is given but
   * *props.message* is falsey, the default message associated with *props.code*
   * will be used as the message for the instance.
   */
  constructor({message, ...props}) {
    super(message || ExtendedError.STANDARD_MESSAGES[props.code]);
    Object.assign(this, props);
  }
}

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
function splitIntoLines(s) {
  const match = /(?:\r?\n|\r)?$/.exec(s);
  s = s.slice(0, match.index);
  const result = s.split(/\r?\n|\r/);
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

/**
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

/**
 * @summary Iterate over NUL-terminated entries in a string
 * @param {string} s - String to iterate
 * @param {function} iteratee - Callback which receives each entry found
 * @returns {string} The remainder of the string after all NUL-terminated entries
 *
 * @description
 * Call iteratee once for each NUL-terminated entry in s; trailing characters
 * (or an empty string) are returned.
 */
function forEachNTE(s, iteratee) {
  let lastTerm = -1;
  for (let i = -1; (i = s.indexOf('\0', i + 1)) >= 0; ) {
    const entry = s.slice(lastTerm + 1, i);
    iteratee(entry);
    lastTerm = i;
  }
  return s.slice(lastTerm + 1);
}

/**
 * @summary Accumulate NUL-terminated records from string chunks
 * @classdesc
 * Use an instance of this class to accumulate NUl-terminated records presented
 * (not necessarily record-aligned) chunk strings.
 *
 * This class passes through several different calls to the Array of entries
 * it has accumulated.
 *
 * @property {string} remainder - The unparsed tail of the strings presented so far
 * @property {Array.<string>} entries - The entries parsed from the presented strings
 */
class NTEAccumulator {
  constructor() {
    this.remainder = '';
    this.entries = [];
  }
  
  /**
   * @method
   * @summary Parse records from a string, capturing any remainder
   * @param {string} s - Next chunk to parse
   * @returns {undefined}
   *
   * @description
   * Because this is the main functionality of this class and is often needs
   * to be passed as a callable (without it's host object), this "method" is
   * defined as a getter that returns a Function bound to the host object.
   */
  get accumulate() {
    return (s) => {
      this.remainder = forEachNTE(this.remainder + s, entry => {
        this.entries.push(entry);
      });
    }
  }
  
  /**
   * @summary Passed through to *this.entries*
   */
  forEach(iteratee) {
    this.entries.forEach(iteratee);
    return this;
  }
  
  /**
   * @summary Passed through to *this.entries*
   */
  flatMap(iteratee) {
    return this.entries.flatMap(iteratee);
  }
  
  /* istanbul ignore next */
  /**
   * @summary Passed through to *this.entries*
   */
  [ Symbol.iterator ]() {
    return this.entries[Symbol.iterator]();
  }
}
