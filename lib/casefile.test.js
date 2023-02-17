import chai, { expect } from 'chai';
import * as double from 'testdouble';
import GitInteraction from './gitInteraction.js';
import { CasefileGroup, CasefileRef, DeletedCasefileRef } from './casefile.js';

beforeEach(() => {
  double.reset();
});

describe('CasefileGroup', () => {
  const groupName = 'aCasefile';
  const instances = [
    'f6298860-0065-54a0-86ce-5e910da5ce8f',
    '638bdfdb-fb89-5e8b-9bfe-e40773c66439',
  ];
  
  beforeEach(async function () {
    this.gitOps = double.instance(GitInteraction);
    this.subject = new CasefileGroup(this.gitOps, groupName, instances);
  });
  
  it(`captures the group name used to construct it`, async function() {
    expect(this.subject).to.have.property('name', groupName);
  });
  
  it(`has CasefileRef instances in its "instances" property`, async function() {
    this.subject.instances.forEach(casefileInstance => {
      expect(casefileInstance).is.instanceOf(CasefileRef);
    });
  });
  
  it(`has an entry in "instances" for each instance used to construct it`, async function() {
    expect(this.subject.instances.map(casefileInstance => casefileInstance.distinguisher)).to.include.members(instances);
  });
});

describe('CasefileRef', () => {
  const groupName = 'aCasefile';
  const distinguisher = 'ee5b6ad4-2df8-58da-8d39-d00961014555';
  
  beforeEach(async function () {
    this.gitOps = double.instance(GitInteraction);
    this.subject = new CasefileRef(this.gitOps, groupName, distinguisher);
  });
  
  describe('properties', () => {
    it(`captures the gitOps used to construct it`, async function() {
      expect(this.subject).has.property('gitOps', this.gitOps);
    });
    
    it(`captures the group name used to construct it`, async function() {
      expect(this.subject).has.property('groupName', groupName);
    });
    
    it(`captures the distinguisher used to construct it`, async function() {
      expect(this.subject).has.property('distinguisher', distinguisher);
    });
    
    it(`computes "path" from the group name and distinguisher`, async function() {
      expect(this.subject.path.split('/')).to.eql([groupName, distinguisher]);
    });
  });
  
  describe('.prototype.getAuthors()', () => {
    const authors = ['Evan Carpenter'];
    
    it(`calls 'getCasefileAuthors' on its 'gitOps', passing its own path`, async function() {
      double.when(this.gitOps.getCasefileAuthors(this.subject.path))
        .thenResolve({ authors });
      const result = await this.subject.getAuthors();
      expect(result).to.eql(authors);
    });
  });
  
  describe('.prototype.load()', () => {
    it(`calls 'getCasefile' on its 'gitOps', passing its own path`, async function() {
      const returnMarker = Symbol('RESULT');
      double.when(this.gitOps.getCasefile(this.subject.path))
        .thenResolve(returnMarker)
      const result = await this.subject.load();
      expect(result).to.equal(returnMarker);
    });
  });
});

describe('DeletedCasefileRef', () => {
  const commit = '146f8b866e8eca4d30068858324cec71c757a57f';
  const committed = new Date();
  const path = 'aCasefile/5bd7d5f4-fb82-5509-9d10-fe528c1d5ba5';
  
  beforeEach(async function () {
    this.gitOps = double.instance(GitInteraction);
    this.subject = new DeletedCasefileRef(this.gitOps, { commit, committed, path });
  });
  
  describe('properties', () => {
    it(`captures the gitOps used to construct it`, async function() {
      expect(this.subject).has.property('gitOps', this.gitOps);
    });
    
    it(`captures the commit is was constructed with as "deletionCommit"`, async function() {
      expect(this.subject).has.property('deletionCommit', commit);
    });
    
    it(`captures the timestamp of the deletion commit`, async function() {
      expect(this.subject).has.property('committed', committed);
    });
    
    it(`captures the path at which the casefile was stored`, async function() {
      expect(this.subject).has.property('path', path);
    });
  });
  
  describe('.prototype.getAuthors()', () => {
    const authors = ['Brett Goodman'];

    it(`calls 'getCasefileAuthors' on its 'gitOps', passing its own path`, async function() {
      double.when(this.gitOps.getCasefileAuthors(path))
        .thenResolve({ authors });
      const result = await this.subject.getAuthors();
      expect(result).to.eql(authors);
    });
  });
  
  describe('.prototype.retrieve', () => {
    it(`calls 'getCasefile' on its 'gitOps', passing its own path and the deletion commit`, async function() {
      const returnMarker = Symbol('RESULT');
      double.when(this.gitOps.getCasefile(path, { beforeCommit: commit }))
        .thenResolve(returnMarker);
      const result = await this.subject.retrieve();
      expect(result).to.equal(returnMarker);
    });
  });
});
