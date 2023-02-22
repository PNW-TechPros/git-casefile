import chai, { expect } from 'chai';
import * as double from 'testdouble';
import { CasefileKeeper } from './index.js';
import { CasefileRef } from './lib/casefile.js';
import DiffInteraction from './lib/diffInteraction.js';
import GitInteraction from './lib/gitInteraction.js';
import GitRemote from './lib/gitRemote.js';

beforeEach(async () => {
  double.reset();
});

describe('CasefileKeeper', () => {
  const tools = {
    gitOps: double.instance(GitInteraction),
    diffOps: double.instance(DiffInteraction),
  };
  const constructSubject = (kwargs = {}) => new CasefileKeeper({
    ...tools,
    ...kwargs,
  });
  
  describe('.prototype.remote()', () => {
    it(`constructs a GitRemote for the specified remote`, async function() {
      const subject = constructSubject();
      expect(subject).has.property('gitOps', tools.gitOps);
      const remoteName = 'aRemote';
      const remote = subject.remote(remoteName);
      expect(remote).is.instanceof(GitRemote).and.have.property('name', remoteName);
      expect(remote).to.have.property('gitOps', tools.gitOps);
    });
  });
  
  describe('.prototype.getRemotes()', () => {
    it(`constructs an Array of GitRemote objects for known git remotes`, async function() {
      const subject = constructSubject();
      const remoteNames = ['remote-1', 'remote-2'];
      double.when(tools.gitOps.getListOfRemotes()).thenResolve(remoteNames);
      const remotes = await subject.getRemotes();
      remotes.forEach(remote => {
        expect(remote).is.instanceof(GitRemote);
        expect(remote).has.property('gitOps', tools.gitOps);
      });
      expect(remotes.map(remote => remote.name)).to.have.all.members(remoteNames);
    });
  });
  
  describe('.prototype.getCasefiles', () => {
    const subject = constructSubject();
    const casefilesData = [
      {name: 'foo', instances: [
        { path: 'foo/f28e0a85-baa8-505f-88ea-e3336640ab33' },
        { path: 'foo/b2e8f5c0-df9c-5db1-8004-4e8dcf35dca4' },
      ]},
      {name: 'bar', instances: [
        { path: 'bar/e1bbf230-274a-5df5-b387-6024eb730685' },
      ]},
    ];
    let casefiles = null;
    
    beforeAll(async function() {
      double.when(tools.gitOps.getListOfCasefiles()).thenResolve(casefilesData);
      casefiles = Object.fromEntries(
        (await subject.getCasefiles()).map(
          casefile => [casefile.name, casefile]
        )
      );
    });
    
    casefilesData.forEach(function ({name, instances}) {
      describe(`casefile '${name}'`, function () {
        it(`was found`, async function() {
          expect(casefiles).has.property(name);
        });
        
        it(`has the name '${name}'`, async function() {
          expect(casefiles[name]).has.property('name', name);
        });
        
        it(`has the ${instances.length} expected entry(ies)`, async function() {
          expect(casefiles[name]).has.property('instances')
            .that.is.an('array').with.lengthOf(instances.length)
            ;
        });
        
        it(`has instances that are CasefileRefs`, async function() {
          casefiles[name].instances.forEach(instance => {
            expect(instance).is.instanceof(CasefileRef);
          });
        });
        
        it(`has an entry in 'instances' for each available casefile instance`, async function() {
          expect(casefiles[name].instances.map(i => i.path))
            .has.members(instances.map(i => i.path))
            ;
        });
      });
    });
  });
  
  describe('.prototype.getDeletedCasefileRefs()', () => {
    it(`can list all deleted casefiles`, async function() {
      const subject = constructSubject();
      const deletedCasefilesData = [
        {commit: '61c14a416991f6b3ae20c1d6f33a5314e4a97857', committed: new Date(), path: 'foo/a6e42e96-d41d-55aa-90c1-28ce4dd96d8e'},
      ];
      double.when(tools.gitOps.getDeletedCasefileRefs(undefined)).thenResolve(
        deletedCasefilesData
      );
      await subject.getDeletedCasefileRefs();
    });
  });
});
