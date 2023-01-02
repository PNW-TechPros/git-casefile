import { normalizeOpts, OptionsError } from './toolInvocationHelpers.js';
import chai, { expect } from 'chai';

describe('normalizeOpts', () => {
  it(`throws if presence-only option key contains equal sign`, function() {
    expect(() => { normalizeOpts({ "n=1": true }) })
      .to.throw(OptionsError).with.property('code', 'BadOptionsKey')
      ;
  });
});
