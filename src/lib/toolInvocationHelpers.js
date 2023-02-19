import CodedError, { ASSERT_ERROR } from './codedError.js';

export const normalizeOpts = (origOpts) => {
  const result = {};
  for (const [ key, value ] of Object.entries(origOpts)) {
    if (key === '-') {
      // Single letter, non-value options
      for (const ch of value) {
        result[ch] = true;
      }
    } else if (value === true && key.includes('=')) {
      throw new OptionsError({
        code: 'BadOptionsKey',
        message: "One or more options key contains an equals sign",
        // Cut through this package's error handling
        [ASSERT_ERROR]: true,
      });
    } else {
      result[key] = value;
    }
  }
  return result;
};

export class OptionsError extends CodedError({}) {}
