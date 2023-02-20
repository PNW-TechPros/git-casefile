import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';
import { PassThrough, Transform, Writable } from 'stream';
import { StringDecoder } from 'string_decoder';

chai.use(chaiAsPromised);

const CONTROLLER = Symbol('controller');

let failSpawn = false;

const childProcessMock = {
  spawn: jest.fn((command, spawnArgs, { stdio, ...spawnOpts}) => {
    if (failSpawn) {
      throw new Error('TEST FAILURE');
    }
    const emitter = new EventEmitter();
    const result = {
      [CONTROLLER]: {
        exitCode: 0,
        emit: emitter.emit.bind(emitter),
      },
      stderr: new PassThrough({ autoDestroy: false }),
      on: emitter.on.bind(emitter),
    };
    if (stdio[0] === 'pipe') {
      result.stdin = new PassThrough();
    }
    if (stdio[1] === 'pipe') {
      result.stdout = new PassThrough();
    }
    process.nextTick(async () => {
      const exitCode = result[CONTROLLER].exitCode;
      if (exitCode != null) {
        if (result.stdout && !result.stdout.writableEnded) {
          await promiseToEnd(result.stdout);
        }
        emitter.emit('exit', exitCode);
      }
    });
    return result;
  }),
};

function spyOn(obj, method, impl) {
  if (!obj) {
    throw new Error(`No methods on ${typeof obj}`);
  }
  const orig = obj[method];
  if (typeof orig !== 'function') {
    throw new Error(`'${method}' is not a method of ${obj.constructor.name}`);
  }
  
  obj[method] = function (...args) {
    let invoked = false, origCallResult;
    const implResult = impl({
      args,
      getResult() {
        if (invoked) {
          return origCallResult;
        }
        invoked = true;
        return (origCallResult = orig(...args));
      },
    });
    return invoked ? implResult : orig.call(obj, ...args);
  };
}

jest.mock('child_process', () => childProcessMock);

let { default: CommandRunner, CommandExecutionError } = require('./commandRunner.js');

describe('CommandRunner', () => {
  const program = 'test-program'; // MUST NOT contain any RegExp special characters
  const toolPath = '/tool/path';
  const currentDirOfExec = '/run/path';
  const toolInvocationEvents = new EventEmitter();
  let logs = null;
  const commandRunnerOptions = {
    path: toolPath,
    cwd: currentDirOfExec,
    tracer: toolInvocationEvents,
    logger: {
      error: (...args) => {
        if (!logs.error) {
          logs.error = [];
        }
        logs.error.push(args);
      }
    },
  };
  const invokeTool = CommandRunner(program, commandRunnerOptions);
  
  function whenToolExecutes(handler) {
    toolInvocationEvents.on('executing', handler);
  }
  
  beforeEach(function () {
    childProcessMock.spawn.mockClear();
    failSpawn = false;
    toolInvocationEvents.removeAllListeners();
    logs = {};
  });
  
  describe('error calling `spawn`', () => {
    beforeEach(() => {
      failSpawn = true;
    });
    
    it(`rejects with code 'SpawningFailure'`, async function() {
      await expect(invokeTool({})).is.rejectedWith(CommandExecutionError)
        .that.eventually.has.property('code', 'SpawningFailure');
    });
  });
  
  describe('path to search for tool', () => {
    async function invokeTool(runnerOpts, invokeOpts) {
      const invoker = CommandRunner(program, {
        ...runnerOpts,
        tracer: toolInvocationEvents,
      });
      return invoker(invokeOpts);
    }
    
    it(`can be specified explicitly with "path" as a string`, async function() {
      await invokeTool({ path: toolPath });
    });
    
    it(`can be retrieved when the tool is invoked by giving a function for "path"`, async function() {
      const path = jest.fn()
        .mockReturnValue(toolPath)
        ;
      whenToolExecutes(async ({ options: { env } }) => {
        expect(env.PATH).to.equal(toolPath);
      });
      await invokeTool({ path });
    });
    
    it(`can come from the environment given for a specific tool invocation`, async function() {
      await invokeTool({}, { env: { PATH: toolPath } });
    });
    
    it(`can come from the environment given for the tool definition`, async function() {
      whenToolExecutes(async ({ options: { env } }) => {
        expect(env.PATH).to.equal(toolPath);
      });
      await invokeTool({ env: { PATH: toolPath } })
    });
  });
  
  describe('"opts" and "args" keywords', () => {
    it(`can run the tool without keyword arguments`, async function() {
      await invokeTool({});
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][0]', program);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.an('array').with.lengthOf(0);
      expect(spawn.calls).to.have.nested.property('[0][2]')
        .which.is.an('object').and.includes({
          cwd: currentDirOfExec,
        });
      expect(spawn.calls).to.have.nested.property('[0][2].env')
        .which.is.an('object').and.includes({
          PATH: toolPath,
        });
      expect(spawn.calls).to.have.nested.property('[0][2].stdio')
        .which.is.eql(['ignore', 'ignore', 'pipe']);
    });
    
    it(`can run the tool with a single letter flag in 'opts'`, async function() {
      await invokeTool({
        opts: { z: true }
      });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.eql([ '-z' ]);
    });
    
    it(`can run the tool with a single letter option w/ argument`, async function() {
      await invokeTool({
        opts: { U: 0 }
      });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.an('array').eql([ '-U', '0' ]);
    });
    
    it(`can run the tool with a long flag`, async function() {
      await invokeTool({
        opts: { stdin: true }
      });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.eql([ '--stdin' ]);
    });
    
    it(`can run the tool with a long option w/ argument`, async function() {
      const pretty = "format:- %H %ci";
      await invokeTool({
        opts: { pretty }
      });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.eql([ `--pretty=${pretty}` ]);
    });
    
    it(`can run the tool with positional arguments`, async function() {
      const args = [ 'base', '--', 'package.json' ];
      await invokeTool({ args });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.eql(args);
    });
    
    it(`can run the tool with flags, options, and positional arguments`, async function() {
      const pretty = 'format:%H';
      const opts = {
        z: true,
        U: 0,
        localized: true,
        pretty,
      };
      const args = [ 'base', '--', 'package.json' ];
      await invokeTool({ opts, args });
      const spawn = childProcessMock.spawn.mock;
      expect(spawn.calls).to.be.an('array').with.lengthOf(1);
      expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.an('array');
      const spawnArgs = spawn.calls[0][1], posArgs = [];
      const argHandlers = {
        "-z"() {},
        "-U"() { expect(spawnArgs.shift()).to.equal('0'); },
        "--localized"() {},
        [`--pretty=${pretty}`]() {},
      };
      while (spawnArgs.length !== 0) {
        const curArg = spawnArgs.shift();
        if (curArg.match(/^--?[^-]/)) {
          const argHandler = argHandlers[curArg] || (() => {
            expect.fail(`Did not expect to see flag/option '${curArg}'`);
          });
          delete argHandlers[curArg];
          argHandler();
        } else {
          posArgs.push(curArg);
        }
      }
      expect(posArgs).to.eql(args);
    });
    
    describe('with subcommand', () => {
      const invokeTool = CommandRunner(program, {
        ...commandRunnerOptions,
        usesSubcommands: true,
      });
      
      it(`can run the tool with just the subcommand`, async function() {
        const subcommand = 'status';
        await invokeTool(subcommand, {});
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(spawn.calls).to.have.nested.property('[0][0]', program);
        expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.an('array').eql([ subcommand ]);
        expect(spawn.calls).to.have.nested.property('[0][2]')
        .which.is.an('object').and.includes({
          cwd: currentDirOfExec,
        });
        expect(spawn.calls).to.have.nested.property('[0][2].env')
        .which.is.an('object').and.includes({
          PATH: toolPath,
        });
        expect(spawn.calls).to.have.nested.property('[0][2].stdio')
        .which.is.eql(['ignore', 'ignore', 'pipe']);
      });
      
      it(`puts the subcommand at the beginning of the argument list`, async function() {
        const subcommand = 'status';
        const pretty = 'format:%H';
        const opts = {
          z: true,
          U: 0,
          localized: true,
          pretty,
        };
        const args = [ 'base', '--', 'package.json' ];
        await invokeTool(subcommand, { opts, args });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(spawn.calls).to.have.nested.property('[0][1]')
        .which.is.an('array');
        const spawnArgs = spawn.calls[0][1], posArgs = [];
        expect(spawnArgs.shift()).to.equal(subcommand);
        const argHandlers = {
          "-z"() {},
          "-U"() { expect(spawnArgs.shift()).to.equal('0'); },
          "--localized"() {},
          [`--pretty=${pretty}`]() {},
        };
        while (spawnArgs.length !== 0) {
          const curArg = spawnArgs.shift();
          if (curArg.match(/^--?[^-]/)) {
            const argHandler = argHandlers[curArg] || (() => {
              expect.fail(`Did not expect to see flag/option '${curArg}'`);
            });
            delete argHandlers[curArg];
            argHandler();
          } else {
            posArgs.push(curArg);
          }
        }
        expect(posArgs).to.eql(args);
      });
    });
    
    describe('using "onedash" format', () => {
      const invokeTool = CommandRunner(program, {
        ...commandRunnerOptions,
        optStyle: 'onedash',
      });
      
      it(`can run the tool with flags, options, and positional arguments`, async function() {
        const pretty = 'format:%H';
        const opts = {
          z: true,
          U: 0,
          localized: true,
          pretty,
        };
        const args = [ 'base', '--', 'package.json' ];
        await invokeTool({ opts, args });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(spawn.calls).to.have.nested.property('[0][1]')
          .which.is.an('array');
        const spawnArgs = spawn.calls[0][1], posArgs = [];
        const argHandlers = {
          "-z"() {},
          "-U"() { expect(spawnArgs.shift()).to.equal('0'); },
          "-localized"() {},
          "-pretty"() { expect(spawnArgs.shift()).to.equal(pretty); },
        };
        while (spawnArgs.length !== 0) {
          const curArg = spawnArgs.shift();
          if (curArg.match(/^--?[^-]/)) {
            const argHandler = argHandlers[curArg] || (() => {
              expect.fail(`Did not expect to see flag/option '${curArg}'`);
            });
            delete argHandlers[curArg];
            argHandler();
          } else {
            posArgs.push(curArg);
          }
        }
        expect(posArgs).to.eql(args);
      });
    });
  });
  
  describe('"stdout" keyword', () => {
    describe('as a function', () => {
      it(`does not have to do anything`, async function() {
        const stdout = jest.fn();
        await invokeTool({ stdout });
      });
      
      it(`receives strings from output chunks written as strings`, async function() {
        const outputChunks = [
          'chunk 1',
          'chunk 2',
        ];
        const stdout = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          for (var chunk of outputChunks) {
            await promiseToWrite(process.stdout, chunk, 'utf8');
          }
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout.mock.calls).to.be.an('array').with.lengthOf(2);
        expect(stdout.mock.calls.map(([ chunk ]) => chunk)).to.eql(outputChunks);
      });
      
      it(`receives strings from output chunks written as Buffers`, async function() {
        const encoding = 'latin1';
        const invokeTool = CommandRunner(program, {
          ...commandRunnerOptions,
          outputEncoding: encoding,
        });
        const outputChunks = [
          'chunk 1 - Á',
          'chunk 2',
        ];
        const stdout = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          for (var chunk of outputChunks) {
            await promiseToWrite(process.stdout, chunk, encoding);
          }
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout.mock.calls).to.be.an('array').with.lengthOf(2);
        expect(stdout.mock.calls.map(([ chunk ]) => chunk)).to.eql(outputChunks);
      });
      
      it(`handles chunks splitting UTF-8 multibyte sequences`, async function() {
        const outputString = 'CÁT';
        const fullBuffer = Buffer.from(outputString, 'utf8');
        const outputBuffers = [
          fullBuffer.slice(0, 2),
          fullBuffer.slice(2),
        ];
        expect(outputBuffers[0]).to.not.eql(Buffer.from(outputBuffers[0].toString('utf8'), 'utf8'));
        const stdout = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          for (var buffer of outputBuffers) {
            await promiseToWrite(process.stdout, buffer, null);
          }
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout.mock.calls).to.be.an('array').with.lengthOf(2);
        expect(stdout.mock.calls.map(([ chunk ]) => chunk)).to.eql(['C', 'ÁT']);
      });
      
      it(`rejects the tool invocation with the exception thrown by handler`, async function() {
        const testError = new Error('TEST ERROR');
        const stdout = jest.fn(() => {
          throw testError;
        });
        const errorCatcher = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          await promiseToWrite(process.stdout, 'chunk', 'utf8');
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await expect(invokeTool({ stdout })).is.rejectedWith(testError);
      });
      
      it(`rejects the tool invocation with the rejection from handler`, async function() {
        const testError = new Error('TEST ERROR');
        const stdout = jest.fn(() => Promise.reject(testError));
        const errorCatcher = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          await promiseToWrite(process.stdout, 'chunk', 'utf8');
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await expect(invokeTool({ stdout })).is.rejectedWith(testError);
      });
      
      it(`rejects the tool invocation with an Error if the thrown value from handler is falsey`, async function() {
        const stdout = jest.fn(() => {
          throw null;
        });
        const errorCatcher = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          await promiseToWrite(process.stdout, 'chunk', 'utf8');
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await expect(invokeTool({ stdout })).is.rejectedWith(Error);
      });
      
      it(`rejects the tool invocation with an Error if the rejection from handler is falsey`, async function() {
        const stdout = jest.fn(() => Promise.reject(null));
        const errorCatcher = jest.fn();
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          await promiseToWrite(process.stdout, 'chunk', 'utf8');
          process.stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await expect(invokeTool({ stdout })).is.rejectedWith(Error);
      });
      
      it(`can be subject to a Transform pipe`, async function() {
        const encoding = 'utf16le', contentStr = 'content';
        const stdout = jest.fn();
        whenToolExecutes(async ({ process }) => {
          delete process[CONTROLLER].exitCode;
          const stdout = process.stdout;
          process.stdout = stdout.pipe(
            new PassThrough().setEncoding(encoding)
          );
          await promiseToWrite(stdout, Buffer.from(contentStr, encoding));
          stdout.end();
          process[CONTROLLER].emit('exit', 0);
        });
        await invokeTool({ stdout });
        expect(stdout.mock.calls)
          .to.be.an('array').with.lengthOf(1)
          ;
        expect(stdout.mock.calls[0])
          .to.be.an('array').with.lengthOf(2)
          ;
        expect(stdout.mock.calls[0]).property(0).to.equal(contentStr);
        expect(stdout.mock.calls[0]).property(1).to.be.a('function');
      });
      
      it(`can stop processing child process output with second parameter`, async function() {
        const outputChunks = [
          'chunk 1',
          'chunk 2',
        ];
        const stdout = jest.fn()
          .mockImplementation((chunk, stop) => { stop(); })
          ;
        let childProc = null;
        whenToolExecutes(async ({ process }) => {
          process[CONTROLLER].exitCode = null;
          await promiseToWrite(process.stdout, outputChunks[0], 'utf8');
          // NOTE: NOT ending process.stdout here
          process[CONTROLLER].emit('exit', 0);
        });
        await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout.mock.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout.mock.calls[0][0]).to.equal(outputChunks[0]);
      });
    });
    
    describe('as a writable stream', () => {
      function makeMockStream() {
        const write = jest.fn((...args) => {
          const [ chunk, encoding, done ] = args;
          done();
        });
        const stream = new Writable({ write });
        stream[CONTROLLER] = {
          get writeCalls() { return write.mock.calls; },
        };
        return stream;
      }
      
      it(`receives buffers from output chunks written as strings`, async function() {
        const outputChunks = [
          'chunk 1',
          'chunk 2',
        ];
        const stdout = makeMockStream();
        let childProc = null;
        whenToolExecutes(async ({ process: childProc }) => {
          childProc[CONTROLLER].exitCode = null;
          for (var chunk of outputChunks) {
            await promiseToWrite(childProc.stdout, chunk, 'utf8');
          }
          childProc.stdout.end();
          process.nextTick(() => {
            childProc[CONTROLLER].emit('exit', 0);
          });
        });
        const tool = await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout[CONTROLLER].writeCalls).to.be.an('array').with.lengthOf(2);
        expect(stdout[CONTROLLER].writeCalls.map(([a]) => a)).to.eql(outputChunks.map((chunk) => Buffer.from(chunk, 'utf8')));
      });
      
      it(`receives buffers from output chunks written as buffers`, async function() {
        const encoding = 'latin1';
        const outputChunks = [
          'Á - chunk 1',
          'chunk 2',
        ];
        const stdout = makeMockStream();
        let childProc = null;
        whenToolExecutes(async ({ process: childProc }) => {
          childProc[CONTROLLER].exitCode = null;
          for (var chunk of outputChunks) {
            const chunkBuffer = Buffer.from(chunk, encoding);
            await promiseToWrite(childProc.stdout, chunkBuffer, 'buffer');
          }
          childProc.stdout.end();
          process.nextTick(() => {
            childProc[CONTROLLER].emit('exit', 0);
          });
        });
        await invokeTool({ stdout });
        const spawn = childProcessMock.spawn.mock;
        expect(spawn.calls).to.be.an('array').with.lengthOf(1);
        expect(stdout[CONTROLLER].writeCalls).to.be.an('array').with.lengthOf(2);
        expect(stdout[CONTROLLER].writeCalls.map(([a]) => a)).to.eql(outputChunks.map((chunk) => Buffer.from(chunk, encoding)));
      });
    });
    
    [true, 'str', {}, new Date(), 42].forEach((stdout) => {
      it(`rejects with code 'BadOutputStream' when given ${stdout}`, async function() {
        await expect(invokeTool({ stdout }))
          .is.rejectedWith(CommandExecutionError)
          .that.eventually.includes({
            code: 'BadOutputStream',
            dest: stdout,
          })
          ;
      });
    });
  });
  
  describe('"feedStdin" keyword', () => {
    it(`receives a callback with the stdin stream`, async function() {
      const content = 'content', encoding = 'utf8';
      const feedStdin = jest.fn((stdin) => {
        stdin.write(content, encoding);
      });
      const stringDecoder = new StringDecoder(encoding);
      let stdinReceived = '';
      whenToolExecutes(async ({ process }) => {
        process.stdin.pipe(new Writable({
          write(chunk, _ignore1, done) {
            if (chunk instanceof Buffer) {
              chunk = stringDecoder.write(chunk);
            }
            stdinReceived += chunk;
            done();
          },
        }))
      });
      await invokeTool({ feedStdin });
      expect(stdinReceived).to.equal(content);
    });
  });
  
  describe('"timeout" keyword', () => {
    function makeInvoker(options) {
      return CommandRunner(program, {...commandRunnerOptions, ...options});
    }
    
    it(`fails with code 'Timeout' if tool does not exit`, async function() {
      let processTimer = null;
      whenToolExecutes(async ({ process: childProc }) => {
        delete childProc[CONTROLLER].exitCode;
        
        processTimer = setTimeout(() => {
          childProc[CONTROLLER].emit('exit', 0);
        }, 1000);
      });
      await expect(makeInvoker({ timeout: 0.1 })({}))
        .is.rejectedWith(CommandExecutionError)
        .which.eventually.has.property('code', 'Timeout')
        ;
      processTimer.unref();
    });
    
    it(`can run without a timeout`, async function() {
      await (makeInvoker({ timeout: null })({}));
    });
  });
  
  describe('result generation', () => {
    it(`calls "exit", if given`, async function() {
      const expectedResult = Symbol('result');
      const exit = jest.fn();
      exit.mockReturnValueOnce(expectedResult);
      const result = await invokeTool({ exit });
      expect(exit.mock.calls).is.an('array').with.lengthOf(1);
      expect(exit.mock.calls).has.nested.property('[0][0]', 0);
      expect(result).to.equal(expectedResult);
    });
    
    it(`passes a non-zero exit code to "exit", if given`, async function() {
      const expectedResult = Symbol('result');
      const exit = jest.fn(), exitCode = 1;
      exit.mockReturnValueOnce(expectedResult);
      whenToolExecutes(async ({ process }) => {
        process[CONTROLLER].exitCode = exitCode;
      });
      const result = await invokeTool({ exit });
      expect(exit.mock.calls).is.an('array').with.lengthOf(1);
      expect(exit.mock.calls).has.nested.property('[0][0]', exitCode);
      expect(result).to.equal(expectedResult);
    });
    
    it(`calls "makeResult", if given`, async function() {
      const expectedResult = Symbol('result');
      const makeResult = jest.fn(() => expectedResult);
      const result = await invokeTool({ makeResult });
      expect(makeResult.mock.calls).is.an('array').with.lengthOf(1);
      expect(makeResult.mock.calls).has.property(0).eql([]);
      expect(result).to.equal(expectedResult);
    });
    
    it(`rejects with code 'ChildProcessFailure' and does not call "makeResult" for a non-zero exit code`, async function() {
      const makeResult = jest.fn();
      whenToolExecutes(async ({ process }) => {
        process[CONTROLLER].exitCode = 1;
      });
      await expect(invokeTool({ makeResult }))
        .is.rejectedWith(CommandExecutionError)
        .that.eventually.has.property('code', 'ChildProcessFailure')
        ;
      expect(makeResult.mock.calls).is.an('array').with.lengthOf(0);
    });
    
    it(`returns "result", if given`, async function() {
      const expectedResult = Symbol('result');
      const result = await invokeTool({ result: expectedResult });
      expect(result).to.equal(expectedResult);
    });
    
    it(`rejects with code 'ChildProcessFailure' rather than return "result" for a non-zero exit code`, async function() {
      const expectedResult = Symbol('result');
      whenToolExecutes(async ({ process }) => {
        process[CONTROLLER].exitCode = 1;
      });
      await expect(invokeTool({ result: expectedResult }))
        .is.rejectedWith(CommandExecutionError)
        .that.eventually.has.property('code', 'ChildProcessFailure')
        ;
    });
    
    it(`prefers "makeResult" over "result"`, async function() {
      const expectedResult = Symbol('result');
      const unexpectedResult = Symbol('red herring');
      const makeResult = jest.fn(() => expectedResult);
      const result = await invokeTool({ result: unexpectedResult, makeResult });
      expect(makeResult.mock.calls).is.an('array').with.lengthOf(1);
      expect(makeResult.mock.calls).has.property(0).eql([]);
      expect(result).to.equal(expectedResult);
    });
    
    it(`prefers "exit" over "makeResult"`, async function() {
      const expectedResult = Symbol('result');
      const unexpectedResult = Symbol('red herring');
      const exit = jest.fn();
      exit.mockReturnValueOnce(expectedResult);
      const makeResult = jest.fn(() => unexpectedResult);
      const result = await invokeTool({ makeResult, exit });
      expect(exit.mock.calls).is.an('array').with.lengthOf(1);
      expect(exit.mock.calls).has.nested.property('[0][0]', 0);
      expect(result).to.equal(expectedResult);
      expect(makeResult.mock.calls).is.an('array').with.lengthOf(0);
    });
  });
  
  describe('child process stderr output', () => {
    it(`sends it to the logger (default: console)`, async function() {
      const content = 'STDERR MESSAGE\n';
      whenToolExecutes(async ({ process: childProc }) => {
        delete childProc[CONTROLLER].exitCode;
        childProc.stderr.write(Buffer.from(content, 'utf8'));
        process.nextTick(() => {
          childProc[CONTROLLER].emit('exit', 0);
        });
      });
      await invokeTool({});
      expect(logs).to.be.an('object')
        .with.property('error').that.is.an('array')
        .that.has.property(0).to.match(
          new RegExp(`^-+ +${program} +-+\n    ${content.trimEnd()}`)
        )
        ;
    });
    
    it(`sends full lines to the logger`, async function() {
      const contents = ['Oh,', ' no!\n'];
      whenToolExecutes(async ({ process: childProc }) => {
        delete childProc[CONTROLLER].exitCode;
        await promiseToWrite(childProc.stderr, Buffer.from(contents[0], 'utf8'), 'buffer');
        await promiseToWrite(childProc.stderr, Buffer.from(contents[1], 'utf8'), 'buffer');
        await promiseToEnd(childProc.stderr);
        process.nextTick(() => {
          childProc[CONTROLLER].emit('exit', 0);
        });
      });
      await invokeTool({});
      expect(logs).to.be.an('object')
        .with.property('error').that.is.an('array')
        .that.has.property(0).to.match(
          new RegExp(`^-+ +${program} +-+\n    ${contents.join('').trimEnd()}`)
        )
        ;
    });
    
    describe('logger execptions', () => {
      const testError = new Error('TEST ERROR');
      const loggerErrorHandler = jest.fn(() => {
        throw testError;
      });
      const invokeTool = CommandRunner(program, {
        ...commandRunnerOptions,
        logger: {
          error: loggerErrorHandler,
        },
      });
      
      beforeEach(() => {
        loggerErrorHandler.mockClear();
      });
      
      it(`captures errors from the logger`, async function() {
        const errorCatcher = jest.fn();
        whenToolExecutes(async ({ process: childProc }) => {
          delete childProc[CONTROLLER].exitCode;
          childProc.stderr.on('error', errorCatcher);
          await promiseToWrite(childProc.stderr, 'HI\n');
          process.nextTick(() => {
            childProc[CONTROLLER].emit('exit', 0);
          });
        });
        await invokeTool({});
        expect(loggerErrorHandler.mock.calls).to.be.an('array').with.lengthOf(1);
        expect(errorCatcher.mock.calls).to.be.an('array').with.lengthOf(1)
          .and.nested.property('[0][0]', testError);
      });
      
      it(`captures errors from the logger at end w/o newline`, async function() {
        const errorCatcher = jest.fn();
        whenToolExecutes(async ({ process: childProc }) => {
          delete childProc[CONTROLLER].exitCode;
          childProc.stderr.on('error', errorCatcher);
          await promiseToWrite(childProc.stderr, 'HI');
          await promiseToEnd(childProc.stderr);
          process.nextTick(() => {
            childProc[CONTROLLER].emit('exit', 0);
          });
        });
        await invokeTool({});
        expect(loggerErrorHandler.mock.calls).to.be.an('array').with.lengthOf(1);
        expect(errorCatcher.mock.calls).to.be.an('array').with.lengthOf(1)
          .and.nested.property('[0][0]', testError);
      });
    });
  });
});

function promiseToWrite(stream, chunk, encoding) {
  return new Promise(function(resolve, reject) {
    stream.write(chunk, encoding, (err) => {
      (err ? reject : resolve)(err);
    });
  });
}

function promiseToEnd(stream) {
  return new Promise(function(resolve, reject) {
    stream.end('', 'utf8', (err) => {
      (err ? reject : resolve)(err);
    });
  });
}
