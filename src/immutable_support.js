import { forEach } from 'underscore';
import { at_maybe, cloneImpl } from '../src-cjs/constants.js';

function ImmutableMixin({spliceOutWithDelete = false}) {
  return {
    [at_maybe]: function (key) {
      return this.has(key) ? {just: this.get(key)} : {};
    },
    [cloneImpl]: function ({pop, set, spliceOut}) {
      if (pop) {
        return this.pop();
      }
      if (set) {
        return this.set(...set);
      }
      if (spliceOut) {
        return spliceOutWithDelete ? this.delete(spliceOut) : this.set(spliceOut, undefined);
      }
      return this;
    },
  };
}

/**
 * @function module:natural-lenses#polyfillImmutable
 * @summary Add lensing support methods to an Immutable type
 * @param {Function} containerType  Target container type for support
 *
 * @description
 * Adds mixin methods for supporting lenses to the given Immutable container
 * type.
 */
function polyfillImmutable(containerType) {
  const isList = containerType.isList;
  const proto = containerType.prototype,
    mixins = ImmutableMixin({spliceOutWithDelete: !isList});
  forEach(
    Object.getOwnPropertySymbols(mixins),
    (name) => {
      if (!proto.hasOwnProperty(name)) {
        Object.defineProperty(proto, name, {
          enumerable: false,
          configurable: true,
          writable: true,
          value: mixins[name],
        });
      }
    }
  )
}

export { polyfillImmutable };
