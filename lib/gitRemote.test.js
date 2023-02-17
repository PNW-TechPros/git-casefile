import chai, { expect } from 'chai';
import * as double from 'testdouble';
import GitInteraction from './gitInteraction.js';
import GitRemote from './gitRemote.js';

beforeEach(() => {
  double.reset();
});

describe('GitRemote', () => {
  const name = 'aRemote';
  
  beforeEach(async function () {
    this.gitOps = double.instance(GitInteraction);
    this.subject = new GitRemote(this.gitOps, name);
  });
  
  describe('.prototype.fetchSharedCasefiles()', () => {
    it(`calls 'fetchSharedCasefilesFromRemote' on its 'gitOps', passing its own name`, async function() {
      await this.subject.fetchSharedCasefiles();
      double.verify(this.gitOps.fetchSharedCasefilesFromRemote(name));
    });
  });
  
  describe('.prototype.commitsUnknown()', () => {
    const casefile = {
      bookmarks: [
        { peg: { commit: '954d36ea7869428b2b59391f6f38345ddc3120a8' } },
        { peg: { commit: '2611e6660e731ad72986c965c3d81f8aa7658238' } },
      ]
    };
    
    it(`calls 'selectCommitsUnknownToRemote' on its 'gitOps', passing its own name`, async function() {
      double.when(this.gitOps.selectCommitsUnknownToRemote(
        name,
        casefile.bookmarks.map(m => m.peg.commit)
      )).thenResolve([ casefile.bookmarks[1].peg.commit ]);
      const result = await this.subject.commitsUnknown(casefile);
      expect(result).to.eql([ casefile.bookmarks[1].peg.commit ]);
    });
    
    it(`returns false if all commits known by this remote`, async function() {
      double.when(this.gitOps.selectCommitsUnknownToRemote(
        name,
        casefile.bookmarks.map(m => m.peg.commit)
      )).thenResolve([]);
      const result = await this.subject.commitsUnknown(casefile);
      expect(result).to.equal(false);
    });
    
    it(`ignores bookmarks without a commit`, async function() {
      const localCasefile = {
        bookmarks: [
          ...casefile.bookmarks,
          {}
        ]
      };
      const commits = casefile.bookmarks.map(m => m.peg.commit);
      double.when(this.gitOps.selectCommitsUnknownToRemote(
        name,
        commits
      )).thenResolve([]);
      await this.subject.commitsUnknown(localCasefile);
    });
  });
  
  describe('.prototype.share()', () => {
    it(`calls 'shareCasefile' on its 'gitOps', passing its own name`, async function() {
      const casefile = {
        path: 'aSharedCasefile/bbcfc42f-941f-5f7d-8409-de59d888b090',
        bookmarks: [],
      };
      const expectedResult = Symbol('result');
      double.when(this.gitOps.shareCasefile(name, casefile.path, casefile.bookmarks))
        .thenResolve(expectedResult);
      const result = await this.subject.share(casefile);
      expect(result).to.equal(expectedResult);
    });
  });
  
  describe('.prototype.pushCommitRefs', () => {
    it(`calls 'push' on its 'gitOps', passing its own name`, async function() {
      const commit = '7775a284f8548babb5aa846ddb636fd91b81a728';
      await this.subject.pushCommitRefs(commit);
      double.verify(this.gitOps.push(
        name,
        {
          source: commit,
          dest: "refs/collaboration/referenced-commits/" + commit,
          force: true,
        },
      ));
    });
  });
  
  describe('.prototype.delete', () => {
    const casefilePath = 'aCasefile/31675173-7ee1-5f3e-afbd-f8940358ba9d';
    
    it(`calls 'deleteCasefilePaths' on its 'gitOps', passing its own name`, async function() {
      await this.subject.delete(casefilePath);
      double.verify(this.gitOps.deleteCasefilePaths(name, [casefilePath]));
    });
    
    it(`works with a Casefile-like object as argument`, async function() {
      const casefile = {
        path: casefilePath,
      };
      await this.subject.delete(casefile);
      double.verify(this.gitOps.deleteCasefilePaths(name, [casefilePath]));
    });
  });
});
