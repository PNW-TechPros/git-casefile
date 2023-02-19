import DiffInteraction, { ASSERT_ERROR, DiffInteractionError } from './diffInteraction.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { readFileSync } from 'fs';
import { jest } from '@jest/globals';
import { PassThrough, finished } from 'stream';
import { temporaryWriteTask } from 'tempy';

chai.use(chaiAsPromised);

describe('DiffInteraction', () => {
  class AssertionError extends Error {
    get [ASSERT_ERROR]() { return true; }
  }
  
  class DiffMock {
    constructor() {
      this.expectedCalls = [];
    }
    
    expectCall(handler, diffArgs) {
      if (diffArgs) {
        expect(diffArgs).to.be.an('object');
        this.expectedCalls.push((actual) => {
          expect(actual.opts).to.deep.equal(diffArgs.opts || {});
          expect(actual.args).to.deep.equal(diffArgs.args || []);
          return handler(actual);
        });
      } else {
        this.expectedCalls.push(handler);
      }
    }
    
    get expectsMoreCalls() {
      return this.expectedCalls.length !== 0;
    }
    
    get run() { return async (kwargs) => {
      if (!this.expectsMoreCalls) {
        throw new AssertionError(`No more executions of 'diff' expected`);
      }
      
      expect(kwargs).to.be.an('object');
      const { opts = {}, args = [], stdout, ...otherKwargs } = kwargs;
      expect(['exit', 'makeResult', 'result'].filter(k => k in otherKwargs)).with.lengthOf(1);
      const { exit, makeResult, result, ...passthroughKwargs } = otherKwargs;
      
      const callHandler = this.expectedCalls.shift();
      const stdio = this._stdoutStream(stdout);
      const stdoutErrorPromise = new Promise((resolve, reject) => {
        stdio.stdout.on('error', err => {
          reject(err);
        });
      });
      const handlerPromise = callHandler({
        ...passthroughKwargs,
        opts,
        args,
        stdio,
      });
      
      const { exitCode = 0 } = (await Promise.race([handlerPromise, stdoutErrorPromise])) || {};
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
    }; }
    
    assertNoMoreExpected() {
      if (this.expectsMoreCalls) {
        throw new Error(`${this.expectedCalls.length} more execution(s) of 'diff' expected`);
      }
    }
    
    _stdoutStream(stdout) {
      const result = {};
      if (stdout && stdout.write) {
        result.stdout = stdout;
      } else {
        result.stdout = new PassThrough().setEncoding('utf8');
        result.stdout.on('data', stdout);
      }
      return result;
    }
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
  
  ////////////////////////////////////////////////////////////////////////
  
  beforeEach(async function () {
    this.diffMock = new DiffMock();
    this.differ = new DiffInteraction({ runDiffCommand: this.diffMock.run });
  });
  
  afterEach( function () {
    this.diffMock.assertNoMoreExpected();
  });
  
  ////////////////////////////////////////////////////////////////////////
  
  describe('.prototype.getHunks()', function () {
    const decodeExecution = ({ opts, args }) => {
      expect(opts).to.deep.equal({ U: 0 });
      expect(args).to.be.an('array').with.lengthOf(2);
      return args.map((path) => readFileSync(path, 'utf8'));
    }
    
    it('handles identical files', async function () {
      const content = {immediate: 'Mary had a little lamb'};
      this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
        const contents = decodeExecution(execution);
        expect(contents[1]).to.equal(contents[0]);
        await streamConsumed(stdout, () => {
          
        });
      });
      const result = await this.differ.getHunks(content, content);
      expect(result).to.be.an('array').with.lengthOf(0);
    });
    
    it('handles insertion of a line', async function () {
      const lines = ['foo', 'bar', 'baz'];
      const contents = [];
      contents.unshift({immediate: lines.map((l) => l + '\n').join('')});
      lines.splice(1, 1);
      contents.unshift({immediate: lines.map((l) => l + '\n').join('')});
      expect(contents[1]).to.not.equal(contents[0]);
      this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
        const contents = decodeExecution(execution);
        expect(contents[1]).to.not.equal(contents[0]);
        await streamConsumed(stdout, () => {
          stdout.write('@@ -1,0 +2\n');
          stdout.write('+bar\n');
        });
        return { exitCode: 1 };
      });
      const result = await this.differ.getHunks(...contents);
      expect(result).to.deep.equal([
        {
          baseStart: 2,
          baseEnd: 2,
          currentStart: 2,
          currentEnd: 3,
        },
      ]);
    });
    
    it('handles deletion of a line', async function () {
      const lines = ['foo', 'bar', 'baz'];
      const contents = [];
      contents.push({immediate: lines.map((l) => l + '\n').join('')});
      lines.splice(1, 1);
      contents.push({immediate: lines.map((l) => l + '\n').join('')});
      expect(contents[1]).to.not.equal(contents[0]);
      this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
        const contents = decodeExecution(execution);
        expect(contents[1]).to.not.equal(contents[0]);
        await streamConsumed(stdout, () => {
          stdout.write('@@ -2 +1,0\n');
          stdout.write('-bar\n');
        });
        return { exitCode: 1 };
      });
      const result = await this.differ.getHunks(...contents);
      expect(result).to.deep.equal([
        {
          baseStart: 2,
          baseEnd: 3,
          currentStart: 2,
          currentEnd: 2,
        },
      ]);
    });
    
    it('handles change of a line', async function () {
      const lines = ['foo', 'bar', 'baz'];
      const contents = [];
      contents.push({immediate: lines.map((l) => l + '\n').join('')});
      lines.splice(1, 1, 'jar');
      contents.push({immediate: lines.map((l) => l + '\n').join('')});
      expect(contents[1]).to.not.equal(contents[0]);
      this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
        const contents = decodeExecution(execution);
        expect(contents[1]).to.not.equal(contents[0]);
        await streamConsumed(stdout, () => {
          stdout.write('@@ -2 +2\n');
          stdout.write('-bar\n');
          stdout.write('+jar\n');
        });
        return { exitCode: 1 };
      });
      const result = await this.differ.getHunks(...contents);
      expect(result).to.deep.equal([
        {
          baseStart: 2,
          baseEnd: 3,
          currentStart: 2,
          currentEnd: 3,
        },
      ]);
    });
    
    it('rejects with code DiffFailure if diff fails', async function () {
      const content = {immediate: 'Mary had a little lamb'};
      this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
        const contents = decodeExecution(execution);
        expect(contents[1]).to.equal(contents[0]);
        await streamConsumed(stdout, () => {
          
        });
        return { exitCode: 17 };
      });
      await expect(this.differ.getHunks(content, content))
        .is.rejectedWith(DiffInteractionError)
        .and.eventually.has.property('code', 'DiffFailure')
        ;
    });
    
    it('rejects with code UnknownContentType when content spec is bad', async function () {
      await expect(this.differ.getHunks(false, true))
        .is.rejectedWith(DiffInteractionError)
        .and.eventually.has.property('code', 'UnknownContentType')
        ;
    });
    
    it(`includes paths for content from specified files as property of DiffFailure`, async function() {
      const content = 'foo\nbar\nbaz\n';
      await temporaryWriteTask(content, async (path) => {
        const baseContent = { path };
        const currentContent = { immediate: content };
        this.diffMock.expectCall(async ({ stdio: { stdout }, ...execution }) => {
          const contents = decodeExecution(execution);
          expect(contents[1]).to.equal(contents[0]);
          await streamConsumed(stdout, () => {
            
          });
          return { exitCode: 17 };
        });
        await expect(this.differ.getHunks(baseContent, currentContent))
          .is.rejectedWith(DiffInteractionError)
          .and.eventually.has.property('base').which.deep.equals({ path })
          ;
      });
    });
  });
});
