import SeparatedRecordConsumer from './SeparatedRecordConsumer.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { jest } from '@jest/globals';

chai.use(chaiAsPromised);

describe('SeparatedRecordConsumer', () => {
  it(`can receive a buffer`, async function() {
    const instance = new SeparatedRecordConsumer('\n').setRecordEncoding('utf8');
    const records = ['foo', 'bar', 'baz'];
    const chunk = Buffer.from(records.join('\n') + '\n', instance.recordEncoding);
    const output = [];
    instance.on('record', record => output.push(record));
    instance.write(chunk);
    expect(output).to.deep.equal(records);
  });
  
  describe('valid separators', () => {
    const makeFrom = (sep) => () => new SeparatedRecordConsumer(sep);
    
    it(`does not allow global RegExp separator`, function() {
      expect(makeFrom(/|/g)).to.throw(/global/);
    });
    
    it(`throws if separator object does not implement Symbol.match`, function () {
      expect(makeFrom({})).to.throw(/Symbol\.match/);
    });
    
    it(`throws for unsupported separator type (typeof)`, function() {
      expect(makeFrom(null)).to.throw(/separator type/);
    });
    
    it(`supports custom separator function`, function() {
      const consumer = new SeparatedRecordConsumer(function(input, startPosition) {
        const match = /\|/.exec(input.slice(startPosition));
        if (!match) return null;
        return { start: match.index + startPosition, length: match[0].length };
      });
      const output = [];
      consumer.on('record', record => output.push(record));
      consumer.write('a|b|c|');
      expect(output).to.deep.equal(['a', 'b', 'c']);
    });
  });
});
