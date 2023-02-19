
/**
 * @property {string} [code] - Programmatically recognizable identifier of error
 */
export default function CodedError(defaultMessages = {}) {
  return class extends Error {
    /**
     * @summary Construction of an instance
     * @param {object} props
     * @param {string} [props.message] - Explicit message for error
     * @param {string} [props.code] - Progammatically recognizable identifier of error
     *
     * @description
     * Except for *props.message*, all *props* passed are assigned to the
     * constructed instance.  If a recognized *props.code* is given but
     * *props.message* is falsey, the default message associated with *props.code*
     * will be used as the message for the instance.
     */
    constructor({message, ...props}) {
      super(message || defaultMessages[props.code]);
      Object.assign(this, props);
    }
  };
};

export const ASSERT_ERROR = Symbol('assertion error');
