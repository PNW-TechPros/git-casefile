import Janitor from './janitor.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { jest } from '@jest/globals';

chai.use(chaiAsPromised);

describe('Janitor', () => {
  beforeEach(function () {
    this.instance = new Janitor();
  });
  
  describe('.prototype.cleanUpSync()', () => {
    it(`does not require tasks`, function() {
      this.instance.cleanUpSync();
    });
    
    it(`can run a single task`, function() {
      const task = jest.fn();
      this.instance.addTask(task);
      this.instance.cleanUpSync();
      expect(task.mock.calls.length).to.equal(1);
      expect(task.mock.calls[0].length).to.equal(0);
    });
    
    it(`passes on a thrown error if only one task throws`, function() {
      const theError = new Error('INTENTIONAL');
      const task = jest.fn(() => { throw theError; });
      this.instance.addTask(task);
      expect(() => this.instance.cleanUpSync()).to.throw(theError);
    });
    
    it(`the task throwing the error is attached as 'task' on the error`, function() {
      const theError = new Error('INTENTIONAL');
      const task = jest.fn(() => { throw theError; });
      this.instance.addTask(task);
      expect(() => this.instance.cleanUpSync()).to.throw(theError)
        .which.has.property('task', task);
    });
    
    it(`handles a thrown null properly`, async function() {
      const task = jest.fn(() => { throw null; });
      this.instance.addTask(task);
      try {
        this.instance.cleanUpSync();
        throw new Error('UNREACHABLE');
      } catch (e) {
        expect(e).to.be.null;
      }
    });
    
    it(`handles a thrown undefined properly`, async function() {
      const task = jest.fn(() => { throw undefined; });
      this.instance.addTask(task);
      try {
        this.instance.cleanUpSync();
        throw new Error('UNREACHABLE');
      } catch (e) {
        expect(e).to.be.undefined;
      }
    });
    
    it(`throws a MultipleCleanupErrors if two or more tasks throw`, function() {
      const taskIds = [1, 2];
      const theErrors = taskIds.map(n => new Error(`INTENTIONAL (${n})`));
      const tasks = taskIds.map((n, i) => jest.fn(() => { throw theErrors[i]; }));
      tasks.forEach(t => this.instance.addTask(t));
      expect(() => this.instance.cleanUpSync())
        .to.throw(Error).with.property('code', 'MultipleCleanupErrors')
        ;
    });
    
    it(`exposes the errors as 'errors' on the thrown error if two or more tasks throw`, function() {
      const taskIds = [1, 2];
      const theErrors = taskIds.map(n => new Error(`INTENTIONAL (${n})`));
      const tasks = taskIds.map((n, i) => jest.fn(() => { throw theErrors[i]; }));
      tasks.forEach(t => this.instance.addTask(t));
      expect(() => this.instance.cleanUpSync())
        .to.throw(Error).that.has.property('errors')
        .with.members(theErrors)
        ;
    });
  });
  
  describe('.prototype.cleanUpAsync()', () => {
    it(`rejects with error from task rejection`, async function() {
      const theError = new Error('INTENTIONAL');
      const task = jest.fn(() => { throw theError; });
      this.instance.addTask(task);
      await expect(this.instance.cleanUpAsync())
        .is.rejectedWith(theError)
        ;
    });
  });
});
