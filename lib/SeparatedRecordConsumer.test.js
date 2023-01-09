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
  
  it(`can receive buffers splitting a UTF-8 character (code point)`, async function() {
    const instance = new SeparatedRecordConsumer('\n').setRecordEncoding('utf8');
    const records = ['foo', 'bär', 'baz'];
    const fullBuffer = Buffer.from(records.join('\n') + '\n', instance.recordEncoding);
    const splitIndex = (function() {
      for (let i = 0; i < fullBuffer.length; ++i) {
        if (fullBuffer[i] >= 0x80) {
          return i;
        }
      }
      return -1;
    }()) + 1;
    expect(splitIndex).is.above(0);
    const output = [];
    instance.on('record', record => output.push(record));
    instance.write(fullBuffer.slice(0, splitIndex));
    instance.write(fullBuffer.slice(splitIndex));
    expect(output).to.deep.equal(records);
  });
  
  it(`can end on a partial character`, async function() {
    const instance = new SeparatedRecordConsumer('\n').setRecordEncoding('utf8');
    const records = ['foo', 'bär', 'baȥ'];
    const fullBuffer = Buffer.from(records.join('\n'), instance.recordEncoding);
    const splitIndex = (function() {
      for (let i = 0; i < fullBuffer.length; ++i) {
        if (fullBuffer[i] >= 0x80) {
          return i;
        }
      }
      return -1;
    }()) + 1;
    expect(splitIndex).is.above(0);
    const output = [];
    instance.on('record', record => output.push(record));
    instance.write(fullBuffer.slice(0, -1));
    await promiseToEnd(instance);
    expect(output.slice(0, -1)).to.eql(records.slice(0, -1));
    expect(output.slice(-1)).to.eql(records.slice(-1).map(r => r.slice(0, -1) + '\uFFFD'));
  });
  
  it(`allows record encoding changes`, async function() {
    const instance = new SeparatedRecordConsumer('\n');
    const records = ['foo', 'bär', 'baȥ'];
    const encodings = ['latin1', 'latin1', 'utf8'];
    const output = [];
    instance.on('record', record => output.push(record));
    records.forEach((rec, i) => {
      const encoding = encodings[i];
      instance.setRecordEncoding(encoding);
      instance.write(Buffer.from(rec + '\n', encoding), null);
    });
    await promiseToEnd(instance);
    expect(output).to.eql(records);
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

function promiseToEnd(stream) {
  return new Promise(function(resolve, reject) {
    stream.end('', 'utf8', (err) => {
      (err ? reject : resolve)(err);
    });
  });
}
