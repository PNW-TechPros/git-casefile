import { strrpart } from './stringUtils.js';
import chai, { expect } from 'chai';

describe('strrpart()', () => {
  it('handles spaces', () => {
    const casefilePath = 'a casefile/22218950-279d-550d-b2c0-d776c50cc6a9';
    expect(strrpart(casefilePath, '/', 2)).to.deep.equal([
      'a casefile',
      '22218950-279d-550d-b2c0-d776c50cc6a9'
    ]);
  });
  
  it('can function like String.prototype.split', () => {
    expect(strrpart('a.b.c', '.')).to.deep.equal(['a', 'b', 'c']);
  });
});
