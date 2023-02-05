const DEBUG_FLAGS = new Set(
  (process.env.DEBUG_FLAGS || '')
  .trim()
  .split(/(?:,|\s)\s*/)
  .filter(x => x)
);

export const debugFlagSet = (name) => DEBUG_FLAGS.has(name);

export const FAIL_ON_LOG = debugFlagSet('failOnLog');
