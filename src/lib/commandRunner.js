import { spawn } from 'child_process';
import { resolve as resolvePath } from 'path';
import { Transform, Writable } from 'stream';
import { StringDecoder } from 'string_decoder';
import CodedError from './codedError.js';

const defaultOptHandlers = {
  gnuopt(value, name) {
    const isLong = name.length > 1;
    const intro = (isLong ? '--' : '-') + name;
    if (value === true) {
      return [intro];
    }
    if (isLong) {
      return [intro + '=' + value];
    }
    return [intro, '' + value];
  },
  
  // This style if for "find" or "java"
  onedash(value, name) {
    const intro = '-' + name;
    if (value === true) {
      return [intro];
    }
    return [intro, '' + value];
  },
};

export class CommandExecutionError extends CodedError({}) {};

/**
 * @event execute
 * @param {string} program
 *    The name of the program to be passed to `child_process.spawn`
 * @param {Array.<string>} arguments
 *    The array of arguments to be passed to `child_process.spawn`
 * @param {object} options
 *    The options object to be passed to `child_process.spawn`
 * @see module:git-casefile/impl.CommandRunner
 *
 * @description
 * This event is emitted to the `opts.tracer` given in a call to
 * [CommandRunner]{@link module:git-casefile/impl.CommandRunner} when the resulting
 * {@link CommandRunnerFunc} or {@link ToolkitRunnerFunc} is called.
 * The event is emitted before `child_process.spawn` is called.  The parameters
 * of the event correspond to the arguments to `child_process.spawn`.
 */
/**
 * @event executing
 * @param {object} props
 * @param {string} props.program
 *    The name of the program passed to `child_process.spawn`
 * @param {Array.<string>} props.arguments
 *    The array of arguments passed to `child_process.spawn`
 * @param {object} props.options
 *    The options object passed to `child_process.spawn`
 * @param {ChildProcess} props.process
 *    The `ChildProcess` returned by `child_process.spawn`
 * @see module:git-casefile/impl.CommandRunner
 *
 * @description
 * This event is emitted to the `opts.tracer` given in a call to
 * [CommandRunner]{@link module:git-casefile/impl.CommandRunner} when the resulting
 * {@link CommandRunnerFunc} or {@link ToolkitRunnerFunc} is called.
 * This event is emitted from the synchronous context in which
 * `child_process.spawn` is called, allowing manipulation of the `stdin`,
 * `stdout`, and `stderr` streams before they are connected to the processing
 * defined for the tool.
 */

/**
 * @callback CommandRunnerFunc
 * @param {object} [kwargs]
 * @param {Object.<string,(string | true)>} [kwargs.opts]
 *    Options for the tool invocation; the `-` property is special: its value
 *    is treated as a list of single letter, non-argument options; option
 *    rendering for `child_process.spawn`'s argument array is controlled by
 *    *opts.optStyle* passed to {@link createCommandRunner}
 * @param {Array.<string>} [kwargs.args]
 *    Positional arguments to pass after the options in the argument array to
 *    `child_process.spawn`
 * @param {(function | Writable)} [kwargs.stdout]
 *    A function to consume strings from STDOUT of the child process *OR* a
 *    writable stream to which STDOUT of the child process will be piped
 * @param {function} [kwargs.feedStdin]
 *    A callback function that receives the STDIN stream of the child process
 *    when it is available; input to the child process may be written or
 *    piped into the STDIN stream
 * @param {function} [kwargs.exit]
 *    Called with the child process's exit code when the process exits; its
 *    return value is the resolved value of this function
 * @param {function} [kwargs.makeResult]
 *    Called if no *kwargs.exit* given and the child process exits with code 0;
 *    its return value is the resolved value of this function
 * @param {function} [kwargs.result]
 *    Value to which this function resolves if the child process exits with
 *    code 0 and neither *kwargs.exit* nor *kwargs.makeResult* are given
 * @param {string} [kwargs.cwd]
 *    Initial current directory in which to launch the child process
 * @param {Object.<string,string>} [kwargs.env]
 *    Environment variables to pass to the child process; if not given, the
 *    environment variables passed to {@link createCommandRunner} are used or,
 *    if those were not given, `process.env` is used
 * @param {{error: function}} [kwargs.logger]
 *    A `console`-like logger to use for logging errors; defaults to the
 *    *opts.logger* passed to {@link createCommandRunner} or, if that was not
 *    given, to `console`
 * @returns {Promise.<*>}
 *
 * @description
 * The resolved value can be the output of *kwargs.exit*, *kwargs.makeResult*,
 * or the value *kwargs.result* (in that order of precedence).  If the child
 * process exits with a non-zero exit code and *kwargs.exit* is not given,
 * this Promise will reject with an error where `err.code === 'ChildProcessFailure'`
 * and `err.exitCode` contains the child process's exit code.  This Promise
 * will also reject, with `err.code === 'Timeout'`, if the child process
 * runs for longer than the allowed period.
 */
/**
 * @callback ToolkitRunnerFunc
 * @param {string} subcommand
 *    The name of the subcommand, passed as the first argument to the program
 * @param {object} [kwargs]
 * @param {Object.<string,string>} [kwargs.opts]
 * @param {Array.<string>} [kwargs.args]
 * @param {(function | Writable)} [kwargs.stdout]
 * @param {function} [kwargs.feedStdin]
 * @param {function} [kwargs.exit]
 * @param {function} [kwargs.makeResult]
 * @param {function} [kwargs.result]
 * @param {string} [kwargs.cwd]
 * @param {Object.<string,string>} [kwargs.env]
 * @param {{error: function}} [kwargs.logger]
 * @returns {Promise.<*>}
 *
 * @description
 * See {@link CommandRunnerFunc} for description of params and return value
 */
/**
 * @function module:git-casefile/impl.CommandRunner
 * @summary Construct a command-runner function
 * @param {string} program
 *    The name of the program to run
 * @param {object} [opts]
 * @param {(string | function)} [opts.path]
 *    Path to search for the program (given in normal style for the platform),
 *    or a function that returns the path
 * @param {string} [opts.cwd]
 *    Path to made the current directory of the tool when it starting
 * @param {Object.<string,string>} [opts.env]
 *    Object mapping environment variable names to values; can be overriden
 *    by passing an `env` property when invoking the tool; defaults to
 *    `process.env`
 * @param {boolean} [opts.usesSubcommands=false]
 *    Whether the returned value is a {@link ToolkitRunnerFunc} (`true`) or
 *    a {@link CommandRunnerFunc} (`false`)
 * @param {string} [opts.optStyle='gnuopt']
 *    A defined style of option rendering to be used with `opts` of the
 *    tool invocation
 * @param {number} [opts.timeout]
 *    Number of seconds to wait for the tool to complete execution before
 *    rejecting with a timeout error (`err.code === 'Timeout'`)
 * @param {{error: function}} [opts.logger]
 *    A console-like object supporting at least an `error` method to which
 *    errors are reported
 * @param {EventEmitter} [opts.tracer]
 *    An EventEmitter on which `'execute'` (pre-execution) and `'executing'`
 *    (after execution starts) events will be emitted
 * @param {string} [opts.outputEncoding]
 *    The name of a string encoding to use when converting output to strings;
 *    only effective for STDOUT if `stdout` prop passed to an invocation is a
 *    function, but also affects STDERR (which defaults to `'utf8'`)
 * @returns {(CommandRunnerFunc | ToolkitRunnerFunc)}
 *
 * @description
 * Invocation of command line tools involves several aspects not covered by
 * NodeJS's `child_process` module: flags, optional arguments, consumption of
 * STDOUT, provision of input on STDIN, propagating STDERR output to a
 * meaningful place (often to `console`), and handling of child process exit
 * codes.
 *
 * The functions returned by this function implement that level of expressivity
 * for invoking command line tools programmatically: flags and optional arguments
 * can be given in an Object (to indicate the irrelevance of ordering and to
 * simplify each tool invocation), STDOUT can be delivered to a function that
 * receives strings (or to a `Writable` stream for more flexibility), timeout
 * capability is baked in, and coordination of result generation is easy;
 * failures reject with a meaningful error.
 */
export default function(program, {
  path,
  cwd,
  env,
  usesSubcommands = false,
  optStyle = 'gnuopt',
  specialOpts = {},
  timeout = 10, // In seconds, or null
  logger,
  tracer, // An optional EventEmitter
  outputEncoding,
} = {}) {
  return async (...args) => {
    const trace = (new Error()).stack.replace(/^(.*\n){2}(\s*at\s*)?/, '');
    let progDesc = program;
    const spawnArgs = [];
    if (usesSubcommands) {
      spawnArgs.push(args.shift());
      progDesc = `${program} ${spawnArgs[0]}`;
    }
    const {
      opts = {},
      args: posArgs = [],
      stdout,
      feedStdin,
      exit,
      makeResult,
      result,
      cwd: overrideCwd,
      env: overrideEnv,
      logger: overrideLogger,
    } = args.shift() || {};
    
    // Set up spawn arguments
    for (const [name, value] of Object.entries(opts)) {
      const handler = specialOpts[name] || defaultOptHandlers[optStyle];
      spawnArgs.push(...handler(value, name));
    }
    spawnArgs.push(...posArgs);
    
    // Set up spawn options
    const { spawnEnv, spawnEnvSource } = (function() {
      if (overrideEnv) {
        return { spawnEnv: overrideEnv, spawnEnvSource: '"env" from tool invocation' };
      }
      if (env) {
        return { spawnEnv: env, spawnEnvSource: '"env" from tool definition' };
      }
      return { spawnEnv: process.env, spawnEnvSource: 'proces.env' };
    }());
    const spawnOpts = {
      cwd: (function() {
          if (typeof overrideCwd === 'undefined') return cwd;
          if (cwd) return resolvePath(cwd, overrideCwd);
          return overrideCwd;
      }()),
      env: {
        ...spawnEnv,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    };
    switch (typeof path) {
      case 'string':
        spawnOpts.env.PATH = path;
        break;
      case 'function':
        spawnOpts.env.PATH = path();
        break;
      default:
        spawnOpts.env.PATH = [overrideEnv, env, process.env].find(
          e => e && e.PATH
        ).PATH;
    }
    
    const closesComplete = {
      stdout: true,
      process: false,
    };
    
    // Set up stdio for spawn
    if (feedStdin) {
      spawnOpts.stdio[0] = 'pipe';
    }
    if (stdout) {
      spawnOpts.stdio[1] = 'pipe';
      closesComplete.stdout = false;
    }
    
    /* istanbul ignore else */
    if (tracer) {
      tracer.emit('execute', program, spawnArgs, spawnOpts);
    }
    
    const childProc = (function() {
      try {
        return spawn(program, spawnArgs, spawnOpts);
      } catch (spawningError) {
        throw new CommandExecutionError({
          code: 'SpawningFailure',
          message: `Error spawning '${progDesc}'`,
          cause: spawningError,
        });
      }
    }());
    
    childProc.stderr.setEncoding(outputEncoding || 'utf8');
    
    /* istanbul ignore else */
    if (tracer) {
      tracer.emit('executing', {
        process: childProc,
        program,
        arguments: spawnArgs,
        options: spawnOpts,
      });
    }
    
    const executionPromise = new Promise(function(resolve, reject) {
      function stepExit() {
        if (Object.values(closesComplete).every(flag => flag !== false)) {
          const exitCode = closesComplete.process;
          if (exit) {
            resolve(exit(exitCode));
          } else if (exitCode) {
            return reject(new CommandExecutionError({
              code: 'ChildProcessFailure',
              message: `${progDesc} exited with code ${exitCode}`,
              exitCode,
              invokedAt: trace,
            }));
          } else {
            resolve(makeResult ? makeResult() : result);
          }
        }
      }
      
      const stderrLogger = (
        overrideLogger
        || logger
        || /* istanbul ignore next */ console
      );
      childProc.stderr
        .pipe(consoleErrorStream(progDesc, stderrLogger))
        .on('error', (err) => childProc.stderr.destroy(err));
      if (childProc.stdout) {
        childProc.stdout
          .pipe(
            streamifyOutput(stdout, outputEncoding)
            .on('close', () => {
              closesComplete.stdout = true;
              stepExit();
            })
            .on('error', (err) => {
              reject(err);
            })
          )
          ;
      }
      
      if (feedStdin) {
        feedStdin(childProc.stdin);
      }
      
      childProc.on('error', reject);
      childProc.on('exit', (code) => {
        closesComplete.process = code;
        stepExit();
      });
    });
    
    if (timeout) {
      let timer = null;
      const timeoutPromise = new Promise(function(resolve, reject) {
        timer = setTimeout(() => {
          reject(new CommandExecutionError({
            code: 'Timeout',
            message: `Timeout on execution of '${progDesc}' after ${timeout} seconds`,
            arguments: spawnArgs.slice(usesSubcommands ? 1 : 0),
            options: {...spawnOpts, env: {
              "Entries from": spawnEnvSource,
              PATH: path
            }},
            invokedAt: trace,
          }));
        }, timeout * 1000);
      });
      return Promise.race([executionPromise, timeoutPromise]).finally(() => {
        timer.unref();
      });
    } else {
      return executionPromise;
    }
  }
}

function streamifyOutput(dest, encoding) {
  if (dest.write) return dest;
  if (typeof dest === 'function') {
    let stringDecoder = null;
    function setBufferEncoding(encoding) {
      stringDecoder = new StringDecoder(encoding);
    }
    setBufferEncoding(encoding || 'utf8');
    const stream = new Writable({
      decodeStrings: false,
      write(chunk, _ignore1, done) {
        let passError = null;
        Promise.resolve(chunk)
          .then((chunk) => (
            chunk instanceof Buffer
            ? stringDecoder.write(chunk)
            : chunk
          ))
          .then((chunk) => dest(
            chunk,
            () => { stream.destroy(); }
          ))
          .catch(e => {
            passError = e || new Error('failure while processing stdout data');
          })
          .finally(() => {
            done(passError);
          })
          ;
      },
    });
    
    return stream;
  }
  let destDesc = typeof dest;
  if (destDesc === 'object') {
    destDesc = dest.constructor.name;
  }
  throw new CommandExecutionError({
    code: 'BadOutputStream',
    message: `Cannot stream to ${destDesc}`,
    dest,
  });
}

function consoleErrorStream(program, logger) {
  let carryover = '';
  let stringDecoder = new StringDecoder('utf8');
  
  function consume(message) {
    if (!message) return;
    logger.error(`----- ${program} -----\n${message.trimEnd()}`.replace(/\n/g, "\n    "));
  }
  
  function lineBlock(chunk) {
    const lastEndl = chunk.lastIndexOf('\n');
    if (lastEndl < 0) {
      carryover = carryover + chunk;
      return '';
    } else {
      const result = carryover + chunk.slice(0, lastEndl + 1);
      carryover = chunk.slice(lastEndl + 1);
      return result;
    }
  }
  
  const stream = new Writable({
    decodeStrings: false,
    write(chunk, _ignore1, done) {
      let passError = null;
      try {
        consume(lineBlock(chunk));
      } catch (e) {
        passError = e;
      }
      done(passError);
    },
    final(done) {
      let passError = null;
      try {
        consume(carryover + stringDecoder.end());
      } catch (e) {
        passError = e;
      }
      done(passError);
    },
  }).on('pipe', (feeder) => {
    /* istanbul ignore else */
    if (feeder.readableEncoding) {
      stringDecoder = new StringDecoder(feeder.readableEncoding);
    }
  });
  return stream;
}
