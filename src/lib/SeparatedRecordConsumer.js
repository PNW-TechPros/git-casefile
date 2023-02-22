import { Writable } from 'stream';
import { StringDecoder } from 'string_decoder';

export default class SeparatedRecordConsumer extends Writable {
  constructor(separator, options) {
    super({...options, decodeStrings: false});
    this._nextSep = createSeparatorFinder(separator);
    this._recordEncoding = null;
    this._stringDecoder = null;
    this._carryover = '';
  }
  
  _write(chunk, encoding, next) {
    if (chunk instanceof Buffer) {
      chunk = this._stringDecoder.write(chunk);
    }
    const working = this._carryover + chunk;
    let iterStart = 0;
    for (
      let sepPos;
      sepPos = this._nextSep(working, iterStart);
      iterStart = sepPos.start + sepPos.length
    ) {
      this.emit(
        'record',
        working.slice(iterStart, sepPos.start),
        () => {
          iterStart = working.length;
          this.destroy();
        },
      );
    }
    this._carryover = working.slice(iterStart);
    next();
  }
  
  _final(next) {
    if (this._stringDecoder) {
      this._carryover = this._carryover + this._stringDecoder.end();
    }
    if (this._carryover) {
      this.emit('record', this._carryover);
      this._carryover = '';
    }
    next();
  }
  
  setRecordEncoding(encoding) {
    if (this._recordEncoding !== encoding) {
      if (this._stringDecoder) {
        this._carryover += this._stringDecoder.end();
      }
      this._recordEncoding = encoding;
      this._stringDecoder = new StringDecoder(encoding);
    }
    return this;
  }
  
  get recordEncoding() { return this._recordEncoding; }
}

function createSeparatorFinder(separator) {
  switch (typeof separator) {
    case 'string':
      return (input, startPosition) => {
        const position = input.indexOf(separator, startPosition);
        if (position === -1) {
          return null;
        }
        return { start: position, length: separator.length };
      };
    case 'function':
      return separator;
    case 'object':
      if (separator === null) break;
      if (separator[Symbol.match]) {
        if (separator.global) {
          throw new Error("RegExp separator may not be global");
        }
        return (input, startPosition) => {
          const match = separator[Symbol.match](input.slice(startPosition));
          if (!match) return null;
          return { start: match.index + startPosition, length: match[0].length };
        }
      }
      throw new Error("'object' separator is not a RegExp (does not implement Symbol.match)");
  }
  throw new Error(`Invalid separator type '${typeof separator}'`);
}
