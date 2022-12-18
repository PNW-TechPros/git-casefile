import GitInteraction, { ASSERT_ERROR, ExtendedError, gitEmptyTree, strrpart } from '../lib/gitInteraction';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { createHash } from 'crypto';
import { jest } from '@jest/globals';
import { PassThrough, finished } from 'stream';

chai.use(chaiAsPromised);

const sharedCasefilesRef = 'refs/collaboration/shared-casefiles';

describe('GitInteraction', () => {
  class AssertionError extends Error {
    get [ ASSERT_ERROR ]() {
      return true;
    }
  }

  class GitMock {
    constructor() {
      this.expectedCalls = [];
    }
    
    expectCall(handler, cmdArgs) {
      if (cmdArgs) {
        expect(cmdArgs).to.be.an('object').and.include.keys('command');
        this.expectedCalls.push((actual) => {
          expect(actual.command).to.equal(cmdArgs.command);
          expect(actual.opts).to.deep.equal(cmdArgs.opts || {});
          expect(actual.args).to.deep.equal(cmdArgs.args || []);
          return handler(actual);
        });
      } else {
        this.expectedCalls.push(handler);
      }
    }
    
    get expectsMoreCalls() {
      return this.expectedCalls.length !== 0;
    }
    
    get run() { return async (command, kwargs) => {
      if (!this.expectsMoreCalls) {
        throw new AssertionError(`No more executions of 'git' expected ('git ${command}')`);
      }
      
      expect(kwargs).to.be.an('object');
      const { opts = {}, args = [], stdout, feedStdin, ...otherKwargs } = kwargs;
      expect(['exit', 'makeResult', 'result'].filter(k => k in otherKwargs)).with.lengthOf(1);
      const { exit, makeResult, result } = otherKwargs;
      
      const callHandler = this.expectedCalls.shift();
      const stdio = this._stdioStreams(stdout);
      const handlerPromise = callHandler({
        command,
        opts,
        args,
        stdio,
      });
      if (feedStdin) {
        feedStdin(stdio.stdin);
        stdio.stdin.end();
      }
      const { exitCode = 0 } = (await handlerPromise) || {};
      
      if (exit) {
        return exit(exitCode || 0);
      } else {
        if (!exitCode) {
          return makeResult ? makeResult() : result;
        } else {
          const message = (
            kwargs.operationDescription
            ? `Unable to ${kwargs.operationDescription}`
            : `'git ${command}' exited with code ${exitCode}`
          );
          throw new ExtendedError({ message, exitCode });
        }
      }
    } };
    
    assertNoMoreExpected() {
      if (this.expectsMoreCalls) {
        throw new Error(`${this.expectedCalls.length} more execution(s) of 'git' expected`);
      }
    }
    
    _stdioStreams(stdout) {
      const result = {
        stdin: new PassThrough().setEncoding('utf8'),
        stdout: new PassThrough().setEncoding('utf8'),
      };
      let bufferedOutput = '';
      result.stdout.on('data', (data) => {
        bufferedOutput += data;
        const tailMatch = bufferedOutput.match(/([^\r\n]*)$/);
        const lines = bufferedOutput.slice(0, tailMatch.index);
        bufferedOutput = bufferedOutput.slice(tailMatch.index);
        const niceLines = lines.replace(/\r\n?/g, '\n');
        if (niceLines) {
          stdout(niceLines);
        }
      });
      result.stdout.on('end', () => {
        if (bufferedOutput) {
          stdout(bufferedOutput);
        }
      });
      return result;
    }
  }
  
  function strFromLines(iterable) {
    return Array.from(iterable, l => '' + l + '\n').join('');
  }
  
  function streamClosure(stream) {
    return new Promise(function(resolve, reject) {
      finished(stream, {}, (err) => err ? reject(err) : resolve());
    });
  }
  
  async function streamConsumed(stream, feeder) {
    const closurePromise = streamClosure(stream);
    await Promise.resolve(feeder(stream));
    stream.end();
    await closurePromise;
  }
  
  async function readAll(stream) {
    const chunks = [];
    return new Promise(function(resolve, reject) {
      stream
        .on('data', (chunk) => chunks.push(chunk))
        .on('end', () => {
          resolve(chunks.join(''));
        })
        .on('error', reject)
        ;
    });
  }
  
  function argumentAssertions(body) {
    try {
      body()
    } catch (e) {
      if (!e[ ASSERT_ERROR ]) {
        e[ ASSERT_ERROR ] = true;
      }
      throw e;
    }
  }
  
  class GitTree {
    constructor(structure) {
      this.structure = structure;
    }
    
    ls(path = '/') {
      let cur = this.structure, hashInputPrefix = '';
      if (path !== '/') {
        hashInputPrefix = path;
        path.split('/').forEach(step => {
          cur = cur[step];
          if (typeof cur === 'string') {
            throw new AssertionError(`${JSON.stringify(path)} is not a tree`);
          }
        });
      }
      hashInputPrefix += '\0';
      return Object.entries(cur).map(([name, content]) => {
        if (typeof content === 'string') {
          return { type: 'blob', mode: '100644', name, hash: content };
        }
        const hasher = createHash('sha1');
        hasher.update(hashInputPrefix);
        Object.keys(cur).sort().forEach(k => hasher.update(k + '\0'));
        return { type: 'tree', mode: '040000', name, hash: hasher.digest('hex') };
      });
    }
    
    blob(path) {
      let cur = this.structure;
      const steps = path.split('/'), blobName = steps.pop();
      steps.forEach((step, level) => {
        cur = cur[step];
        if (typeof cur === 'string') {
          throw new AssertionError(`${JSON.stringify(step)} at level ${level} is not a tree`);
        }
      });
      if (typeof cur[blobName] !== 'string') {
        throw new AssertionError(`${JSON.stringify(path)} is not a blob`);
      }
      return { type: 'blob', mode: '100644', name: blobName, hash: cur[blobName] };
    }
    
    subtree(path) {
      const [containerPath, name] = path.includes('/') ? strrpart(path, '/', 2) : [ '', path ];
      const entry = this.ls(containerPath || undefined).find(
        e => e.name === name
      );
      if (!entry || entry.type !== 'tree') {
        console.error({ entry });
        throw new AssertionError(`${JSON.stringify(path)} is not a tree`);
      }
      return entry;
    }
  }
  
  //////////////////////////////////////////////////////////////////////////
  
  const UNEXPECTED_CALL = Symbol('unexpected call');
  
  beforeEach(async function () {
    this.gitMock = new GitMock();
    this.repo = new GitInteraction({ runGitCommand: this.gitMock.run });
    const repoMethodsMocked = this.repoMethodsMocked = new Set();
    this.repo.mockMethod = (function (name, impl) {
      expect(this).to.have.property(name).which.is.a('function');
      this[name] = jest.fn(async () => {
        throw Object.assign(
          new AssertionError(`Too many calls to '${name}'`),
          { [UNEXPECTED_CALL]: true }
        );
      });
      if (impl) {
        this[name].mockImplementation(impl);
      } else {
        repoMethodsMocked.add(name);
      }
      return this[name];
    }).bind(this.repo);
  });
  
  afterEach(async function () {
    this.gitMock.assertNoMoreExpected();
    
    // Check that each mocked method on this.repo is called the
    // expected number of times
    const uncalledMockImpls = [];
    for (const mname of this.repoMethodsMocked) {
      try {
        await this.repo[mname]();
        uncalledMockImpls.push(mname);
      } catch (e) {
        if (!e[UNEXPECTED_CALL]) {
          uncalledMockImpls.push(mname);
        }
      }
    }
    if (uncalledMockImpls.length !== 0) {
      throw new Error([
        "Uncalled mock implementations:",
        ...uncalledMockImpls
      ].join("\n    - "));
    }
  });
  
  //////////////////////////////////////////////////////////////////////////
  
  describe('.prototype.getListOfRemotes()', function () {
    it('returns a single remote', async function () {
      const expectedResult = ['origin'];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(strFromLines(expectedResult));
        });
      }, { command: 'remote' });
      const result = await this.repo.getListOfRemotes();
      expect(result).to.deep.equal(expectedResult);
    });
    
    it('returns multiple remotes', async function () {
      const expectedResult = ['origin', 'testing'];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(strFromLines(expectedResult));
        });
      }, { command: 'remote' });
      const result = await this.repo.getListOfRemotes();
      expect(result).to.deep.equal(expectedResult);
    });
  });
  
  describe('.prototype.fetchSharedCasefilesFromRemote()', function () {
    it('fetches from a valid remote name', async function () {
      const remote = "aRemote";
      this.gitMock.expectCall(async () => {}, {
        command: 'fetch',
        args: [
          remote,
          `+${sharedCasefilesRef}*:${sharedCasefilesRef}*`,
        ],
      });
      const result = await this.repo.fetchSharedCasefilesFromRemote(remote);
      expect(result).to.equal(null);
    });
    
    it('returns an error when given an invalid remote name', async function () {
      const remote = "aRemote";
      this.gitMock.expectCall(async () => {
        return { exitCode: 128 };
      }, {
        command: 'fetch',
        args: [
          remote,
          `+${sharedCasefilesRef}*:${sharedCasefilesRef}*`,
        ],
      });
      await expect(this.repo.fetchSharedCasefilesFromRemote(remote))
        .is.rejectedWith(ExtendedError);
    });
  });
  
  describe('.prototype.getListOfCasefiles()', function () {
    const expectedOpts = {r: true, z: true, 'full-tree': true};
    const expectedArgs = [sharedCasefilesRef];
    
    it('lists casesfiles in the tree', async function () {
      const casefileName = 'a casefile';
      const instanceId = 'ed421d07-97a9-5cb4-ba17-866e68ae5ce5';
      this.gitMock.expectCall(async ({ stdio: { stdout }}) => {
        await streamConsumed(stdout, () => {
          stdout.write(`100644 blob 05ceffd002e09e8cdc8db79bd37c52d66eb4e612\t${casefileName}/${instanceId}\0`);
        });
      }, { command: 'ls-tree', opts: expectedOpts, args: expectedArgs });
      const result = await this.repo.getListOfCasefiles();
      expect(result).to.deep.equal([
        {name: casefileName, instances: [{path: `${casefileName}/${instanceId}`}]},
      ]);
    });
    
    it('returns an empty array on an error', async function () {
      this.gitMock.expectCall(async ({ command, opts, args }) => {
        return { exitCode: 128 };
      }, { command: 'ls-tree', opts: expectedOpts, args: expectedArgs });
      const result = await this.repo.getListOfCasefiles();
      expect(result).to.deep.equal([]);
    });
    
    it('groups instances of the same casefile name', async function () {
      const casefileName = 'a casefile';
      const instanceIds = [
        '22218950-279d-550d-b2c0-d776c50cc6a9',
        'ed421d07-97a9-5cb4-ba17-866e68ae5ce5',
      ];
      this.gitMock.expectCall(async ({ stdio: { stdout }}) => {
        await streamConsumed(stdout, () => {
          stdout.write(`100644 blob 05ceffd002e09e8cdc8db79bd37c52d66eb4e612\t${casefileName}/${instanceIds[0]}\0`);
          stdout.write(`100644 blob 2fb8b967b5b10d97b3af6a7b41f06e8c74ff31ff\t${casefileName}/${instanceIds[1]}\0`);
        });
      }, { command: 'ls-tree', opts: expectedOpts, args: expectedArgs });
      const result = await this.repo.getListOfCasefiles();
      expect(result).to.deep.equal([
        {name: casefileName, instances: [
          {path: `${casefileName}/${instanceIds[0]}`},
          {path: `${casefileName}/${instanceIds[1]}`},
        ]},
      ]);
    });
    
    it('handles casefile names containing a slash', async function () {
      const casefileName = 'groupA/casefile1';
      const instanceIds = [
        '22218950-279d-550d-b2c0-d776c50cc6a9',
        'ed421d07-97a9-5cb4-ba17-866e68ae5ce5',
      ];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(`100644 blob 05ceffd002e09e8cdc8db79bd37c52d66eb4e612\t${casefileName}/${instanceIds[0]}\0`);
          stdout.write(`100644 blob 2fb8b967b5b10d97b3af6a7b41f06e8c74ff31ff\t${casefileName}/${instanceIds[1]}\0`);
        });
      }, { command: 'ls-tree', opts: expectedOpts, args: expectedArgs })
      const result = await this.repo.getListOfCasefiles();
      expect(result).to.deep.equal([
        {name: casefileName, instances: [
          {path: `${casefileName}/${instanceIds[0]}`},
          {path: `${casefileName}/${instanceIds[1]}`},
        ]},
      ]);
    });
  });
  
  describe('.prototype.getAuthors()', function () {
    const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
    
    it('folds multiple entries for the same author together', async function () {
      const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
      const author = 'Ruth Schneider';
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(`${author}\n`);
          stdout.write(`${author}\n`);
        });
      }, {
        command: 'log',
        opts: { pretty: 'format:%aN' },
        args: [ sharedCasefilesRef, '--', casefilePath ],
      });
      const result = await this.repo.getAuthors(casefilePath);
      expect(result).to.deep.equal({
        path: casefilePath,
        authors: [ author ],
      });
    });

    it('sorts the names of multiple authors', async function () {
      const authors = [
        'Willie Terry',
        'Ruth Schneider',
        'Rosetta Long',
      ];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          authors.forEach(author => {
            stdout.write(`${author}\n`);
          });
        });
      }, {
        command: 'log',
        opts: { pretty: 'format:%aN' },
        args: [ sharedCasefilesRef, '--', casefilePath ],
      });
      const result = await this.repo.getAuthors(casefilePath);
      expect(result).to.deep.equal({
        path: casefilePath,
        authors: [ ...authors ].sort(),
      });
      expect(result.authors).not.to.deep.equal(authors);
    });
  });
  
  describe('.prototype.getContentLines()', function () {
    const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
    
    it('can retrieve the content lines of a file', async function () {
      const content = JSON.stringify({
        bookmarks: [],
      });
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(content);
        })
      }, {
        command: 'show',
        args: [ `${sharedCasefilesRef}:${casefilePath}` ],
      });
      const result = await this.repo.getContentLines(casefilePath);
      expect(result).to.deep.equal([content]);
    });
    
    it('rejects if git exits with an error', async function () {
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        return { exitCode: 128 };
      }, {
        command: 'show',
        args: [ `${sharedCasefilesRef}:${casefilePath}` ],
      });
      await expect(this.repo.getContentLines(casefilePath)).is.rejected;
    });
    
    it('can retrieve the content lines of a file as it existed before a given commit', async function () {
      const commit = '3216d5b5cdbfd83374046326d997699f9484c5ca';
      const parentCommit = '080a2d0b05a3e98afbc6d220c05f8d33b0b75e31';
      const lastChange = '2110-07-08 13:05:35.340 -0700';
      const content = JSON.stringify({
        bookmarks: [],
      });
      this.repo.mockMethod('findLatestCommitParentWithPath')
        .mockResolvedValueOnce(parentCommit)
        ;
      this.gitMock.expectCall(async ({ command, opts, args, stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(content);
        })
      }, {
        command: 'show',
        args: [ `${parentCommit}:${casefilePath}` ],
      });
      const result = await this.repo.getContentLines(casefilePath, {
        beforeCommit: commit,
      });
      expect(result).to.deep.equal([content]);
    });
  });
  
  describe('.prototype.fetchFromRemote()', function () {
    it('fetches from the specified remote', async function () {
      const remote = 'aRemote';
      this.gitMock.expectCall(async () => {
      }, { command: 'fetch', args: [ remote ] });
      await this.repo.fetchFromRemote(remote);
    });
  });
  
  describe('.prototype.selectCommitsUnknownToRemote()', function () {
    it('can run successfully', async function () {
      const remote = 'aRemote';
      const commits = {
        '2dad5d0e3f0c780488e1ad70471c56e36565f0af': [],
        '9d3aca58bc5be212de9a9c9273662515d8d784ea': [ 'foo', 'bar' ],
      };
      this.repo.testIfCommitKnownToRemote = jest.fn(async (remote, commit) => {
        expect(commits).to.have.property(commit);
        const branches = commits[commit];
        delete commits[commit];
        return branches.length !== 0;
      });
      const result = await this.repo.selectCommitsUnknownToRemote(remote, Object.keys(commits));
      expect(result).to.deep.equal([ '2dad5d0e3f0c780488e1ad70471c56e36565f0af' ]);
    });
  });
  
  
  describe('.prototype.shareCasefile()', function () {
    const remote = 'aRemote';
    const casefileName = 'a casefile';
    const casefileInstance = '22218950-279d-550d-b2c0-d776c50cc6a9';
    const casefilePath = `${casefileName}/${casefileInstance}`;
    const bookmarksHash = '435071dfcb377fd5daf0798ee5132a53c9b58c69';
    const groupTreeHash = 'ecc98cc31b7dc39e12c0bfdd72c28cd086428844';
    const otherCasefileHash = '75ac66cc3004e06dc5229a4458c9785522166921';
    const rootTreeHash = '3d50a1b0783972ee391dcae4b0d0f97876edace6';
    const newCommitHash = '4572c0e84c9024ceb8d5059a346aa940a55332a4';
    const treeEntry_blob = { mode: '100644', type: 'blob' };
    const treeEntry_tree = { mode: '040000', type: 'tree' };
    
    const bookmarks = [
      {}
    ];
    
    beforeEach(function() {
      this.repo.mockMethod('getHashOfCasefile')
        .mockImplementationOnce(async (bookmarks) => {
          argumentAssertions(() => {
            expect(bookmarks).to.deep.equal(bookmarks);
          });
          return bookmarksHash;
        })
        ;
      this.pushesNewCommit = function () {
        this.repo.mockMethod('push')
          .mockImplementationOnce(async (remote, opts) => {
            argumentAssertions(() => {
              expect(remote).to.equal(remote);
              expect(opts).to.be.an('object');
              expect(opts.source).to.equal(newCommitHash);
              expect(opts.dest).to.equal(sharedCasefilesRef);
              expect(opts.force).to.not.be.ok;
            });
            return null;
          })
          ;
        this.repo.mockMethod('updateRef')
          .mockImplementationOnce(async (refName, commit) => {
            argumentAssertions(() => {
              expect(refName).to.equal(sharedCasefilesRef);
              expect(commit).to.equal(newCommitHash);
            });
            return null;
          })
          ;
      }
    });
    
    it('works when no sharing ref exists in the remote repo', async function () {
      this.pushesNewCommit();
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (...args) => {
          argumentAssertions(() => {
            expect(args).to.deep.equal([ sharedCasefilesRef ]);
          });
          throw new Error("Unknown ref");
        })
        ;
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(`${gitEmptyTree}:${casefileName}`);
          return [];
        })
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(gitEmptyTree);
          return [];
        })
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.lengthOf(1);
            expect(entries[0]).to.be.an('object').and.include({
              ...treeEntry_blob,
              hash: bookmarksHash,
              name: casefileInstance,
            });
          });
          return groupTreeHash;
        })
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.deep.members([
              {
                ...treeEntry_tree,
                hash: groupTreeHash,
                name: casefileName,
              }
            ]);
          });
          return rootTreeHash;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, opts) => {
          argumentAssertions(() => {
            expect(tree).to.equal(rootTreeHash);
            expect(opts).to.be.an('object');
            expect(opts.message).to.be.a('string');
            expect(opts.parents).to.deep.equal([  ]);
          });
          return newCommitHash;
        })
        ;
      const result = await this.repo.shareCasefile(remote, casefilePath, bookmarks);
      expect(result).to.include({
        commit: newCommitHash,
      });
    });
    
    it('works when a sharing ref exists in the remote repo', async function () {
      this.pushesNewCommit();
      const sharedCasefileCommit = 'f65132e550ab8d8dbc576e2c3293c4e4f12808a6';
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (...args) => {
          argumentAssertions(() => {
            expect(args).to.deep.equal([ sharedCasefilesRef ]);
          });
          return sharedCasefileCommit;
        })
        ;
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          return [
            // {...treeEntry_blob, hash: 'b13194a733629886fa1ad2f5d0ebf92b8bb184d5', name: `${casefileName}` }
          ];
        })
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(sharedCasefileCommit);
          return [
            {
              ...treeEntry_tree, name: `otherCasefile`,
              hash: otherCasefileHash,
            },
          ];
        })
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.lengthOf(1);
            expect(entries[0]).to.be.an('object').and.include({
              ...treeEntry_blob,
              hash: bookmarksHash,
              name: casefileInstance,
            });
          });
          return groupTreeHash;
        })
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.deep.members([
              {
                ...treeEntry_tree,
                hash: otherCasefileHash,
                name: 'otherCasefile'
              },
              {
                ...treeEntry_tree,
                hash: groupTreeHash,
                name: casefileName,
              }
            ]);
          });
          return rootTreeHash;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, opts) => {
          argumentAssertions(() => {
            expect(tree).to.equal(rootTreeHash);
            expect(opts).to.be.an('object');
            expect(opts.message).to.be.a('string');
            expect(opts.parents).to.deep.equal([ sharedCasefileCommit ]);
          });
          return newCommitHash;
        })
        ;
      const result = await this.repo.shareCasefile(remote, casefilePath, bookmarks);
      expect(result).to.include({
        commit: newCommitHash,
      });
    });
    
    it('works when a different instance exists in the remote repo', async function () {
      this.pushesNewCommit();
      const sharedCasefileCommit = 'f65132e550ab8d8dbc576e2c3293c4e4f12808a6';
      const otherInstance = {
        ...treeEntry_blob,
        hash: 'b13194a733629886fa1ad2f5d0ebf92b8bb184d5',
        name: 'otherInstance',
      };
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (...args) => {
          argumentAssertions(() => {
            expect(args).to.deep.equal([ sharedCasefilesRef ]);
          });
          return sharedCasefileCommit;
        })
        ;
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          return [ otherInstance ];
        })
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(sharedCasefileCommit);
          return [
            {
              ...treeEntry_tree, name: `otherCasefile`,
              hash: otherCasefileHash,
            },
          ];
        })
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').and.include.deep.members([
              {
                ...treeEntry_blob,
                hash: bookmarksHash,
                name: casefileInstance,
              },
              otherInstance
            ])
          });
          return groupTreeHash;
        })
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.deep.members([
              {
                ...treeEntry_tree,
                hash: otherCasefileHash,
                name: 'otherCasefile'
              },
              {
                ...treeEntry_tree,
                hash: groupTreeHash,
                name: casefileName,
              }
            ]);
          });
          return rootTreeHash;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, opts) => {
          argumentAssertions(() => {
            expect(tree).to.equal(rootTreeHash);
            expect(opts).to.be.an('object');
            expect(opts.message).to.be.a('string');
            expect(opts.parents).to.deep.equal([ sharedCasefileCommit ]);
          });
          return newCommitHash;
        })
        ;
      const result = await this.repo.shareCasefile(remote, casefilePath, bookmarks);
      expect(result).to.include({
        commit: newCommitHash,
      });
    });
    
    it('works when updating the casefile instance in the remote repo', async function () {
      this.pushesNewCommit();
      const sharedCasefileCommit = 'f65132e550ab8d8dbc576e2c3293c4e4f12808a6';
      const oldContentHash = 'b1ce129dc7ccd73e1c4a9a90a85a59bc87db277a';
      expect(oldContentHash).to.not.equal(bookmarksHash);
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (...args) => {
          argumentAssertions(() => {
            expect(args).to.deep.equal([ sharedCasefilesRef ]);
          });
          return sharedCasefileCommit;
        })
        ;
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          return [ {
            ...treeEntry_blob,
            hash: oldContentHash,
            name: casefileInstance,
          } ];
        })
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(sharedCasefileCommit);
          return [
            {
              ...treeEntry_tree, name: casefileName,
              hash: otherCasefileHash,
            },
          ];
        })
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').and.include.deep.members([
              {
                ...treeEntry_blob,
                hash: bookmarksHash,
                name: casefileInstance,
              },
            ])
          });
          return groupTreeHash;
        })
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.be.an('array').with.deep.members([
              {
                ...treeEntry_tree,
                hash: groupTreeHash,
                name: casefileName,
              }
            ]);
          });
          return rootTreeHash;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, opts) => {
          argumentAssertions(() => {
            expect(tree).to.equal(rootTreeHash);
            expect(opts).to.be.an('object');
            expect(opts.message).to.be.a('string');
            expect(opts.parents).to.deep.equal([ sharedCasefileCommit ]);
          });
          return newCommitHash;
        })
        ;
      const result = await this.repo.shareCasefile(remote, casefilePath, bookmarks);
      expect(result).to.include({
        commit: newCommitHash,
      });
    });
    
    it('returns indication if not changed', async function () {
      const sharedCasefileCommit = 'f65132e550ab8d8dbc576e2c3293c4e4f12808a6';
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (...args) => {
          argumentAssertions(() => {
            expect(args).to.deep.equal([ sharedCasefilesRef ]);
          });
          return sharedCasefileCommit;
        })
        ;
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          return [ {
            ...treeEntry_blob,
            hash: bookmarksHash,
            name: casefileInstance,
          } ];
        })
        ;
      const result = await this.repo.shareCasefile(remote, casefilePath, bookmarks);
      expect(result).to.include({
        commit: sharedCasefileCommit,
      });
      expect(result).to.have.property('message')
        .which.matches(/[Nn]o changes?|[Nn]ot changed/)
        ;
    });
  });
  
  describe('.prototype.deleteCasefilePaths()', function () {
    const treeEntry_blob = { mode: '100644', type: 'blob' };
    const treeEntry_tree = { mode: '040000', type: 'tree' };
    const remote = 'aRemote';
    const casefileName = 'a casefile';
    const sharedCasefileCommit = '6d2b9a4817c7bfcfc96e32be53faf787c5c81a54';
    
    beforeEach(function () {
      const revParse = this.repo.mockMethod('revParse');
      this.repoHasSharedCasefiles = () => {
        revParse.mockImplementationOnce(async (committish) => {
          argumentAssertions(() => {
            expect(committish).to.equal(sharedCasefilesRef);
          });
          return sharedCasefileCommit;
        });
      };
    });
    
    it('removes a single-instance casefile group', async function () {
      const instanceId = 'a78be7f9-cbba-597f-85ca-3a426196518d';
      const path = `${casefileName}/${instanceId}`;
      const tree = new GitTree({
        [casefileName]: {
          [instanceId]: '15db6073c72015de83e5b7ad4a0a059a27767d86',
        },
        otherCasefile: {
          "dc07e538-c97b-5f46-820b-f0770931451d": '86c5567fe29c3a743ec4e8c3f3862b35232ff5f5',
        },
      });
      const newCasefilesTree = 'a557f29be5172767c1d3870a6d1c430573b5b0a3';
      const newCasefilesCommit = 'ca2311efbcd29f2217231c7631d4b480f825b87c';
      this.repoHasSharedCasefiles();
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          });
          return tree.ls(casefileName);
        })
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(sharedCasefileCommit);
          });
          return tree.ls();
        });
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.have.deep.members([
              tree.subtree('otherCasefile'),
            ]);
          });
          return newCasefilesTree;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, { parents, message }) => {
          argumentAssertions(() => {
            expect(tree).to.equal(newCasefilesTree);
            expect(parents).to.deep.equal([ sharedCasefileCommit ]);
            expect(message).to.be.a('string');
          });
          return newCasefilesCommit;
        })
        ;
      this.repo.mockMethod('push')
        .mockImplementationOnce(async (targetRemote, { source, dest, force }) => {
          argumentAssertions(() => {
            expect(targetRemote).to.equal(remote);
            expect(source).to.equal(newCasefilesCommit);
            expect(dest).to.equal(sharedCasefilesRef);
            expect(force).to.not.be.ok;
          });
        })
        ;
      this.repo.mockMethod('updateRef')
        .mockImplementationOnce(async (refName, commit) => {
          argumentAssertions(() => {
            expect(refName).to.equal(sharedCasefilesRef);
            expect(commit).to.equal(newCasefilesCommit);
          });
        })
        ;
      await this.repo.deleteCasefilePaths(remote, [ path ]);
    });
    
    it('removes the one-and-only casefile', async function () {
      const instanceId = 'f2ee1070-d893-55db-992b-eda4d1b34f52';
      const path = `${casefileName}/${instanceId}`;
      const tree = new GitTree({
        [casefileName]: {
          [instanceId]: '399043bd8a60efee43ca0d5b522da094fa69cbb5',
        },
      });
      this.repoHasSharedCasefiles();
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          });
          return tree.ls(casefileName);
        })
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(sharedCasefileCommit);
          });
          return tree.ls();
        });
        ;
      this.repo.mockMethod('push')
        .mockImplementationOnce(async (targetRemote, { source, dest, force }) => {
          argumentAssertions(() => {
            expect(targetRemote).to.equal(remote);
            expect(source).to.equal('');
            expect(dest).to.equal(sharedCasefilesRef);
            expect(force).to.not.be.ok;
          });
        })
        ;
      this.repo.mockMethod('updateRef')
        .mockImplementationOnce(async (refName, commit) => {
          argumentAssertions(() => {
            expect(refName).to.equal(sharedCasefilesRef);
            expect(commit).to.equal('');
          });
        })
        ;
      await this.repo.deleteCasefilePaths(remote, [ path ]);
    });
    
    it('does nothing if all given paths are absent from shared casefiles tree', async function () {
      const casefileName = 'a casefile';
      const instanceId = '2a66a2ea-a400-5e0c-bd26-8365eaaedecc';
      const path = `${casefileName}/${instanceId}`;
      const tree = new GitTree({
        [casefileName]: {
          otherInstance: '399043bd8a60efee43ca0d5b522da094fa69cbb5',
        },
      });
      
      this.repoHasSharedCasefiles();
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          });
          throw new Error('No such tree');
        })
        ;
      await this.repo.deleteCasefilePaths(remote, [ path ]);
    });
    
    it('removes one instance from a multi-instance casefile group', async function () {
      const instanceId = 'a78be7f9-cbba-597f-85ca-3a426196518d';
      const path = `${casefileName}/${instanceId}`;
      const tree = new GitTree({
        [casefileName]: {
          [instanceId]: '15db6073c72015de83e5b7ad4a0a059a27767d86',
          otherInstance: '01156fcca7f57566bf02892d2c352ea112caf573',
        },
      });
      const newGroupTree = '4a267f765b0b525a3235a29cfff24c087f5e9923';
      const newCasefilesTree = 'a557f29be5172767c1d3870a6d1c430573b5b0a3';
      const newCasefilesCommit = 'ca2311efbcd29f2217231c7631d4b480f825b87c';
      this.repoHasSharedCasefiles();
      this.repo.mockMethod('lsTree')
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(`${sharedCasefileCommit}:${casefileName}`);
          });
          return tree.ls(casefileName);
        })
        .mockImplementationOnce(async (treeish) => {
          argumentAssertions(() => {
            expect(treeish).to.equal(sharedCasefileCommit);
          });
          return tree.ls();
        });
        ;
      this.repo.mockMethod('mktree')
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.have.deep.members([
              tree.blob(`${casefileName}/otherInstance`),
            ]);
          });
          return newGroupTree;
        })
        .mockImplementationOnce(async (entries) => {
          argumentAssertions(() => {
            expect(entries).to.have.deep.members([
              {
                ...treeEntry_tree,
                name: casefileName,
                hash: newGroupTree,
              }
            ]);
          });
          return newCasefilesTree;
        })
        ;
      this.repo.mockMethod('commitCasefilesTree')
        .mockImplementationOnce(async (tree, { parents, message }) => {
          argumentAssertions(() => {
            expect(tree).to.equal(newCasefilesTree);
            expect(parents).to.deep.equal([ sharedCasefileCommit ]);
            expect(message).to.be.a('string');
          });
          return newCasefilesCommit;
        })
        ;
      this.repo.mockMethod('push')
        .mockImplementationOnce(async (targetRemote, { source, dest, force }) => {
          argumentAssertions(() => {
            expect(targetRemote).to.equal(remote);
            expect(source).to.equal(newCasefilesCommit);
            expect(dest).to.equal(sharedCasefilesRef);
            expect(force).to.not.be.ok;
          });
        })
        ;
      this.repo.mockMethod('updateRef')
        .mockImplementationOnce(async (refName, commit) => {
          argumentAssertions(() => {
            expect(refName).to.equal(sharedCasefilesRef);
            expect(commit).to.equal(newCasefilesCommit);
          });
        })
        ;
      await this.repo.deleteCasefilePaths(remote, [ path ]);
    });
    
    it('does nothing if no shared casefiles exist', async function () {
      const instanceId = 'a78be7f9-cbba-597f-85ca-3a426196518d';
      const path = `${casefileName}/${instanceId}`;
      const tree = new GitTree({
        [casefileName]: {
          [instanceId]: '15db6073c72015de83e5b7ad4a0a059a27767d86',
        },
        otherCasefile: {
          "dc07e538-c97b-5f46-820b-f0770931451d": '86c5567fe29c3a743ec4e8c3f3862b35232ff5f5',
        },
      });
      const newCasefilesTree = 'a557f29be5172767c1d3870a6d1c430573b5b0a3';
      const newCasefilesCommit = 'ca2311efbcd29f2217231c7631d4b480f825b87c';
      this.repo.mockMethod('revParse')
        .mockImplementationOnce(async (committish) => {
          argumentAssertions(() => {
            expect(committish).to.equal(sharedCasefilesRef);
          });
          throw new Error("No such commit");
        })
        ;
      await this.repo.deleteCasefilePaths(remote, [ path ]);
    });
  });
  
  describe('.prototype.revParse()', function () {
    it('resolves a valid committish', async function () {
      const committish = sharedCasefilesRef;
      const expectedHash = 'e0de45865af50fd70508636b66bd1ab8249bdf91';
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          stdout.write(`${expectedHash}\n`);
        })
      }, { command: 'rev-parse', args: [ committish ]})
      const result = await this.repo.revParse(committish);
      expect(result).to.equal(expectedHash);
    });
    
    it('rejects on an invalid committish', async function () {
      const committish = sharedCasefilesRef;
      const expectedHash = 'e0de45865af50fd70508636b66bd1ab8249bdf91';
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        return { exitCode: 128 };
      }, { command: 'rev-parse', args: [ committish ]})
      await expect(this.repo.revParse(committish)).is.rejected;
    });
  });
  
  describe('.prototype.lsTree()', function () {
    const treeEntry_blob = { mode: '100644', type: 'blob' };
    const treeEntry_tree = { mode: '040000', type: 'tree' };
    const treeish = 'ff64367e984a1df13daab8a77f322a1c0f6a1512';
    const expectedGitCmd = {
      command: 'ls-tree',
      opts: { z: true, 'full-tree': true },
    }
    
    it('queries git for tree entries', async function () {
      const entries = [
        { ...treeEntry_blob, hash: '1dea27b5f691a54ed3e54bbdbeebbd642b061ab5', name: 'normalName' },
        { ...treeEntry_tree, hash: 'ec9a6eea7239df82b2056ff93f2d0e01c9d7ba09', name: 'normalTreeName' },
        { ...treeEntry_blob, hash: '01a7387841daa84e81558fd75f26de79d0c77776', name: 'name with spaces' },
        { ...treeEntry_blob, hash: 'ed7c4d40378b7138cfca31abad56ea50cf5ca09b', name: 'name\twith\ttabs' },
        { ...treeEntry_blob, hash: '00776f6e1c2bedea4d6fd2fc28fa5cfeada6b7b7', name: 'name\nwith\nnewlines' },
      ];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, async () => {
          for (const { mode, type, hash, name } of entries) {
            stdout.write(`${mode} ${type} ${hash}\t${name}\0`);
          }
        });
      }, {...expectedGitCmd, args: [ treeish ] });
      const result = await this.repo.lsTree(treeish);
      expect(result).to.deep.equal(entries);
    });
    
    it('resolves to empty list it git indicates error', async function () {
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        return { exitCode: 128 };
      }, {...expectedGitCmd, args: [ treeish ] });
      const result = await this.repo.lsTree(treeish);
      expect(result).to.deep.equal([]);
    });
  });
  
  describe('.prototype.mktree', function () {
    const treeEntry_blob = { mode: '100644', type: 'blob' };
    const treeEntry_tree = { mode: '040000', type: 'tree' };
    const entries = [
      { ...treeEntry_blob, hash: '1dea27b5f691a54ed3e54bbdbeebbd642b061ab5', name: 'normalName' },
      { ...treeEntry_tree, hash: 'ec9a6eea7239df82b2056ff93f2d0e01c9d7ba09', name: 'normalTreeName' },
      { ...treeEntry_blob, hash: '01a7387841daa84e81558fd75f26de79d0c77776', name: 'name with spaces' },
      { ...treeEntry_blob, hash: 'ed7c4d40378b7138cfca31abad56ea50cf5ca09b', name: 'name\twith\ttabs' },
      { ...treeEntry_blob, hash: '00776f6e1c2bedea4d6fd2fc28fa5cfeada6b7b7', name: 'name\nwith\nnewlines' },
    ];
    const expectedGitCmd = { command: 'mktree', opts: { z: true } };
    const newTreeHash = '5d9d359cc025338137cc3cde0f38b37d6dcec0bd';
    
    it('invokes git to build, store, and hash the contents of a tree', async function () {
      this.gitMock.expectCall(async ({ stdio: { stdin, stdout } }) => {
        const input = await readAll(stdin);
        expect(input).to.be.a('string');
        expect(input.slice(-1)).to.equal('\0');
        const inputEntries = input.slice(0, -1).split('\0');
        expect(inputEntries).to.have.lengthOf(entries.length);
        inputEntries.forEach((inputEntry, i) => {
          const entryId = `entry at index ${i}`;
          expect(inputEntry.startsWith(entries[i].mode + ' '), entryId).to.be.true;
          expect(inputEntry, entryId).to.include(' ' + entries[i].type + ' ');
          expect(inputEntry, entryId).to.include(' ' + entries[i].hash + '\t');
          expect(inputEntry.endsWith('\t' + entries[i].name), entryId).to.be.true;
        });
        await streamConsumed(stdout, () => {
          stdout.write(newTreeHash + '\n');
        });
      }, expectedGitCmd);
      const result = await this.repo.mktree(entries);
      expect(result).to.equal(newTreeHash);
    });
    
    it('does not allow slashes in the entry names', async function () {
      const badEntry = { ...treeEntry_blob, hash: 'b72bb79d446ac7ebb51e375adf86dd41c2af3a44', name: 'bad/name' }
      await expect(this.repo.mktree(entries.concat([ badEntry ])))
        .is.rejected.eventually.with.property('code', 'InvalidTreeEntry')
        ;
    });
  });
  
  describe('.prototype.push()', function () {
    const remote = 'aRemote';
    const source = '359e374bcf1e4671e87c86b9d54d821c98977b87';
    const dest = 'refs/heads/someBranch';
    
    it('can resolve successfully', async function () {
      this.gitMock.expectCall(async () => {
        
      }, { command: 'push', args: [ remote, `${source}:${dest}` ] });
      const result = await this.repo.push(remote, { source, dest });
    });
    
    it('can reject (e.g. history conflict)', async function () {
      this.gitMock.expectCall(async () => {
        return { exitCode: 1 };
      }, { command: 'push', args: [ remote, `${source}:${dest}` ] });
      await expect(this.repo.push(remote, { source, dest }))
        .is.rejected;
    });
    
    it('can be told to force-push', async function () {
      this.gitMock.expectCall(async () => {
        
      }, { command: 'push', args: [ remote, `+${source}:${dest}` ] });
      const result = await this.repo.push(remote, { source, dest, force: true });
    });
  });
  
  describe('.prototype,udpateRef()', function () {
    it('directs git to update a reference', async function () {
      const newCommitHash = 'd0902f1cada49a2e5fb698dfc63ebae747fe8cb9';
      this.gitMock.expectCall(async () => {
        
      }, { command: 'update-ref', args: [ sharedCasefilesRef, newCommitHash ] });
      const result = await this.repo.updateRef(sharedCasefilesRef, newCommitHash);
    });
  });
  
  describe('.prototype.getDeletedCasefileRefs', function () {
    const expectedGitCmdAndOpts = {
      command: 'log',
      opts: {
        'z': true,
        'diff-filter': 'D',
        'name-status': true,
        'pretty': 'format:- %H %ci',
      },
    }
    
    it('does not require an argument', async function () {
      const deletionRecords = [
        {
          commit: 'b725fae446a0485746dad8d3bd25dbcbc28b15a7',
          committed: '2022-01-01 07:08:09 -0500',
          path: `a casefile/10455878-85b8-5b94-bb16-9aba80af2c20`
        },
        {
          commit: '058fcf40ecbe251ce643964b5aca951b155351a3',
          committed: '2021-12-01 07:08:09 -0500',
          path: 'somethingElse/abe0e3ca-8e0e-589a-92c0-ac1f914a10f6'
        },
        {
          commit: '058fcf40ecbe251ce643964b5aca951b155351a3',
          committed: '2021-12-01 07:08:09 -0500',
          path: `a casefile/3abbb254-414c-5c99-9201-7ab81fa58d0a`
        },
      ];
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
          const recs = deletionRecords;
          stdout.write(`- ${recs[0].commit} ${recs[0].committed}\n`);
          stdout.write(`D\0${recs[0].path}\0`);
          stdout.write('\0');
          stdout.write(`- ${recs[1].commit} ${recs[1].committed}\n`);
          stdout.write(`D\0${recs[1].path}\0`);
          expect(recs[1].commit).to.equal(recs[2].commit);
          expect(recs[1].committed).to.equal(recs[2].committed);
          stdout.write(`D\0${recs[2].path}\0`);
          stdout.write('\0');
        });
      }, {
        ...expectedGitCmdAndOpts,
        args: [ sharedCasefilesRef ]
      });
      const result = await this.repo.getDeletedCasefileRefs();
      expect(result).to.have.deep.members(deletionRecords);
    });
    
    it(`can accept a partial name for searching`, async function() {
      const searchPartial = 'abc';
      this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
        await streamConsumed(stdout, () => {
        });
      }, {
        ...expectedGitCmdAndOpts,
        args: [ sharedCasefilesRef, '--', `*${searchPartial}*/*` ]
      });
      const result = await this.repo.getDeletedCasefileRefs("abc");
      expect(result).to.be.an('array').with.lengthOf(0);
    });
    
    it(`responds with an empty Array if git command fails`, async function() {
      this.gitMock.expectCall(async () => {
        return { exitCode: 128 };
      }, {
        ...expectedGitCmdAndOpts,
        args: [ sharedCasefilesRef ]
      });
      const result = await this.repo.getDeletedCasefileRefs();
      expect(result).to.be.an('array').with.lengthOf(0);
    });
  });
  
  describe('(private)', function () {
    describe('.prototype.findLatestCommitParentWithPath()', function () {
      const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
      const queriedCommit = 'bbbc833b00cfcde6bcdaff06d9068aecb9e5ecf2';
      const expectedGitCmd = { command: 'rev-parse', args: [ queriedCommit + '^@' ]};
      
      it('returns undefined when no parents found', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, () => {
          });
        }, expectedGitCmd);
        const result = await this.repo.findLatestCommitParentWithPath(casefilePath, queriedCommit);
        expect(result).to.be.undefined;
      });
      
      it('returns the hash of a single parent', async function () {
        const parentCommit = '6885e998ddd642967f4ef9d0a5fde071169810d9';
        this.repo.mockMethod('getDateOfLastChange')
          .mockResolvedValueOnce(3188173563756544)
          ;
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, () => {
            stdout.write(parentCommit + '\n');
          });
        }, expectedGitCmd);
        const result = await this.repo.findLatestCommitParentWithPath(casefilePath, queriedCommit);
        expect(result).to.equal(parentCommit);
      });
      
      it('returns the hash of the most recent parent', async function () {
        const mostRecentParentCommit = 'f771b18d9312f8970e8085f745fddbfc49d8a8d4';
        const parentCommits = {
          [ mostRecentParentCommit ]: 7926077775151104,
          'fa37d436f3634f4910ccb8f925785275ac5f7a90': 7926077775040003,
        };
        this.repo.mockMethod('getDateOfLastChange', async (path, { commit }) => {
          expect(path).to.equal(casefilePath);
          if (!parentCommits.hasOwnProperty(commit)) {
            throw new AssertionError(`Unknown commit ${commit}`);
          }
          if (parentCommits[commit] == null) {
            throw new AssertionError(`${commit} has already been queried`);
          }
          const result = parentCommits[commit];
          parentCommits[commit] = null;
          return result;
        });
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, () => {
            for (const parentCommit of Object.keys(parentCommits)) {
              stdout.write(parentCommit + '\n');
            }
          });
        }, expectedGitCmd);
        const result = await this.repo.findLatestCommitParentWithPath(casefilePath, queriedCommit);
        expect(result).to.equal(mostRecentParentCommit);
      });
    });
    
    describe('.prototype.getDateOfLastChange()', function () {
      const path = 'some/branch/name';
      const dateOfLastChange = '2031-11-27 12:47:40.855 -0800';
      
      it('resolves to the last change time of the given branch', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, async () => {
            stdout.write(dateOfLastChange + '\n');
          });
        }, {
          command: 'log',
          opts: { pretty: 'format:%ci', n: '1' },
          args: [ 'HEAD', '--', path ],
        });
        const result = await this.repo.getDateOfLastChange(path);
        expect(result).to.equal(new Date(dateOfLastChange).getTime());
      });
      
      it('can be limited to change no later than a specific commit', async function () {
        const limitingCommit = 'a9014c320c9e457828253140e08b05ec82a1d9fd';
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, async () => {
            stdout.write(dateOfLastChange + '\n');
          });
        }, {
          command: 'log',
          opts: { pretty: 'format:%ci', n: '1' },
          args: [ limitingCommit, '--', path ],
        });
        const result = await this.repo.getDateOfLastChange(path, { commit: limitingCommit });
        expect(result).to.equal(new Date(dateOfLastChange).getTime());
      });
      
      it('resolves with 0 if the path does not exist', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, async () => {
            // no output
          });
        }, {
          command: 'log',
          opts: { pretty: 'format:%ci', n: '1' },
          args: [ 'HEAD', '--', path ],
        });
        const result = await this.repo.getDateOfLastChange(path);
        expect(result).to.equal(0);
      });
    });
    
    describe('.prototype.testIfCommitKnownToRemote()', function () {
      const remote = 'aRemote';
      const commit = '760ea8bbc9b929e5e2f7a0e595fdd656802446b0';
      const expectedGitCmd = {
        command: 'branch',
        opts: { r: true, contains: commit },
        args: [ `${remote}/*` ],
      }
      
      it('resolves true for a commit known to the remote (as of most recent fetch)', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, async () => {
            stdout.write(`${remote}/main\n`);
          });
        }, expectedGitCmd);
        const result = await this.repo.testIfCommitKnownToRemote(remote, commit);
        expect(result).to.be.true;
      });

      it('resolves false for a commit unknown to the remote (as of most recent fetch)', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, async () => {
            // no output
          });
        }, expectedGitCmd);
        const result = await this.repo.testIfCommitKnownToRemote(remote, commit);
        expect(result).to.be.false;
      });

      it('rejects for a commit unknown to the repo', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          return { exitCode: 129 };
        }, expectedGitCmd);
        await expect(this.repo.testIfCommitKnownToRemote(remote, commit))
          .is.rejected;
      });
    });
    
    describe('.prototype.getHashOfCasefile()', function () {
      const bookmarks = [
        {
          file: 'index.js', markText: 'file', line: 17,
          peg: {commit: '9abc1c50f9f304a627c2d5d9a4f7bf5b354983de', line: 23},
        },
        { file: 'index.js', markText: 'package', line: 58 },
      ];
      const expectedGitCmd = {
        command: 'hash-object',
        opts: { w: true, stdin: true},
      };
      const bookmarksHash = 'eccfd42944159c3db35a1ff3eaf40f5d5759896e';
      
      it('writes the given bookmarks to the Git repo', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdin, stdout } }) => {
          expect(JSON.parse(await readAll(stdin))).to.have.property('bookmarks')
            .that.is.deep.equal(bookmarks);
          await streamConsumed(stdout, async () => {
            stdout.write(bookmarksHash + '\n');
          })
        }, expectedGitCmd);
        const result = await this.repo.getHashOfCasefile(bookmarks);
        expect(result).to.equal(bookmarksHash);
      });
      
      it('rejects with code "GitWriteFailed" if git output is invalid', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdin, stdout } }) => {
          expect(JSON.parse(await readAll(stdin))).to.have.property('bookmarks')
            .that.is.deep.equal(bookmarks);
        }, expectedGitCmd);
        await expect(this.repo.getHashOfCasefile(bookmarks))
          .is.rejectedWith(ExtendedError)
          .that.eventually.has.property('code', 'GitWriteFailed')
          ;
      });
    });
    
    describe('.prototype.commitCasefilesTree()', function () {
      const tree = '1bba797dfab6ae1cc965bd364d76729eed93f706';
      const message = "A new commit";
      const newCommit = '7e378725ad1be05f0472beb8cc750c9cd430706e';
      const expectedGitCmd = { command: 'commit-tree', opts: { 'm': message } };
      
      it('creates a commit from a tree hash and a message', async function () {
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, () => {
            stdout.write(newCommit + '\n');
          });
        }, { ...expectedGitCmd, args: [ tree ] });
        const result = await this.repo.commitCasefilesTree(tree, { message });
        expect(result).to.equal(newCommit);
      });
      
      it('creates a commit from a tree, parents, and a message', async function () {
        const parents = [
          'af7f07b53a94e7d3faa8f1de6b5c2dcc176f86ba',
          '215fce1e5035c4a04ff7e936b595778bec76e452',
        ];
        this.gitMock.expectCall(async ({ stdio: { stdout } }) => {
          await streamConsumed(stdout, () => {
            stdout.write(newCommit + '\n');
          });
        }, { ...expectedGitCmd, args: [
          ...(parents.flatMap(h => ['-p', h])),
          tree
        ] });
        const result = await this.repo.commitCasefilesTree(tree, { parents, message });
        expect(result).to.equal(newCommit);
      });
    });
  });
});

describe('strrpart()', () => {
  it('handles spaces', () => {
    const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
    expect(strrpart(casefilePath, '/', 2)).to.deep.equal([
      'a casefile',
      '22218950-279d-550d-b2c0-d776c50cc6a9'
    ]);
  });
});
