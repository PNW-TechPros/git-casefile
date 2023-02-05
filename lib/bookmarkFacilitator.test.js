import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import dedent from 'dedent';
import { jest } from '@jest/globals';
import * as double from 'testdouble';
import BookmarkFacilitator from './bookmarkFacilitator.js';
import CodedError from './codedError.js';
import DiffInteraction from './diffInteraction.js';
import { NoEditor } from './editor.js';
import GitInteraction from './gitInteraction.js';

import { FAIL_ON_LOG } from '../test/helpers.js';

class InjectedError extends CodedError({}) {};

class EditBufferGenerator {
  constructor(lines) {
    this.lines = lines;
    this.buffers = [];
  }
  
  createBuffer() {
    const buffer = {
      lineText: double.func(),
    };
    double.when(buffer.lineText(), {ignoreExtraArgs: true}).thenDo(
      (i) => this.lines[i - 1]
    );
    this.buffers.push(buffer);
    return buffer;
  }
}

const file = 'recipe.md';
// Copied under Creative Commons Attribution License 3.0 from
// https://www.foodista.com/recipe/KZFXTKNG/penne-pasta-peas-and-bacon
const fileContent = dedent`
  # Ingredients

  * 1 Tbsp olive oil
  * ½ diced very small yellow onion
  * 1 cup frozen peas
  * 6 thick slices cut into small slices bacon
  * ¾ pound penne pasta
  * ¼ cup heavy cream
`.split(/\n/);

describe('BookmarkFacilitator', () => {
  const forbiddenLoggerMethods = new Set(`
    count debug dir dirxml error group groupCollapsed groupEnd info log
    table time timeEnd timeLog trace warn profile profileEnd timeStamp
  `.trim().split(/\s+/));

  beforeEach(function () {
    this.editBufferGenerator = new EditBufferGenerator(fileContent);
    const logger = new Proxy(console, {
      get(target, prop, receiver) {
        if (forbiddenLoggerMethods.has(prop)) {
          const error = new Error(`console.${prop} called`);
          if (FAIL_ON_LOG) {
            throw error;
          }
          console.error(error);
        }
        return target[prop];
      },
    });
    this.subject = new BookmarkFacilitator({
      logger,
      gitOps: this.gitOps = double.instance(GitInteraction),
      diffOps: this.diffOps = double.instance(DiffInteraction),
      editor: this.editor = double.instance(NoEditor),
    });
  });
  
  describe('.prototype.currentLocation()', () => {
    it(`can compute current location of a full bookmark present in an unchanged section`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 5,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenResolve({ line: 7 });
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark before the first changed section`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 7,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 8, baseEnd: 9, currentStart: 8, currentEnd: 8 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark after a changed section`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 5,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 2, baseEnd: 3, currentStart: 2, currentEnd: 5 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark text in a changed section (later line)`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 5,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 4, baseEnd: 7, currentStart: 4, currentEnd: 8 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark text in a changed section (prime line)`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 7,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 4, baseEnd: 8, currentStart: 4, currentEnd: 8 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark text in a changed section (earlier line)`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'peas',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 8,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 4, baseEnd: 9, currentStart: 4, currentEnd: 8 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 5, col: 16 });
    });
    
    it(`can locate the bookmark in an inserted section`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 7,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 7, baseEnd: 7, currentStart: 7, currentEnd: 9 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark text near the original line`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 5,
        },
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenReject(new InjectedError({ code: 'LineNotFound' }));
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 4, baseEnd: 7, currentStart: 4, currentEnd: 4 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`can locate the bookmark text near the original line without git linkage`, async function() {
      const bookmark = {
        file,
        line: 6,
        markText: 'penne',
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
    });
    
    it(`falls back from faulty blame result`, async function() {
      const bookmark = {
        file,
        line: 7,
        markText: 'penne',
        peg: {
          commit: 'aa297bc2960f492fe3ce8f52011d25ff4348fdec',
          line: 5,
        },
      };
      this.subject.logger = {
        warn: jest.fn(),
      };
      double.when(this.editor.open(file)).thenResolve(
        this.editBufferGenerator.createBuffer()
      );
      double.when(this.gitOps.findCurrentLinePosition(file, bookmark.peg, undefined))
        .thenResolve({ line: 3 });
      double.when(this.gitOps.getBlobContent(file, { commit: bookmark.peg.commit }))
        .thenResolve(null);
      double.when(this.diffOps.getHunks({ immediate: null }, { path: file }))
        .thenResolve([
          { baseStart: 2, baseEnd: 3, currentStart: 2, currentEnd: 5 }
        ]);
      const result = await this.subject.currentLocation(bookmark);
      expect(result).to.eql({ file, line: 7, col: 11 });
      expect(this.subject.logger.warn.mock.calls).to.be.an('array').with.lengthOf(1);
    });
  });
  
  describe('.prototype.computeLinePeg()', () => {
    const currentLine = 7;
    const commit = '4d1c3acd73ba84e6278d9185f9a98007681dcb88';
    
    it(`can return the result for a committed line`, async function() {
      double.when(this.gitOps.lineIntroduction(file, currentLine, { commit: null, liveContent: undefined }))
        .thenResolve({ commit, line: currentLine });
      const result = await this.subject.computeLinePeg(file, currentLine);
      expect(result).to.eql({ commit, line: currentLine });
    });
    
    it(`can estimate within an uncommitted section`, async function() {
      double.when(this.gitOps.lineIntroduction(file, currentLine, { commit: null, liveContent: undefined }))
        .thenReject(new InjectedError({ code: 'NoCommitFound' }));
      double.when(this.gitOps.revParse('HEAD'))
        .thenResolve(commit);
      double.when(this.editor.liveContent(file))
        .thenResolve(undefined);
      double.when(this.gitOps.getBlobContent(file, { commit: null }))
        .thenResolve(fileContent);
      double.when(this.diffOps.getHunks({ immediate: fileContent }, { path: file }))
        .thenResolve([
          { baseStart: 6, baseEnd: 9, currentStart: 6, currentEnd: 9 },
        ]);
      const result = await this.subject.computeLinePeg(file, currentLine);
      expect(result).to.eql({ commit, line: currentLine });
    });
    
    it(`returns the line without a commit if git fails`, async function() {
      double.when(this.gitOps.lineIntroduction(file, currentLine, { commit: null, liveContent: undefined }))
        .thenReject(new InjectedError({ code: 'SpawningFailure' }));
      double.when(this.gitOps.revParse('HEAD'))
        .thenReject(new InjectedError({ code: 'SpawningFailure' }));
      double.when(this.editor.liveContent(file))
        .thenResolve(undefined);
      double.when(this.gitOps.getBlobContent(file, { commit: null }))
        .thenReject(new InjectedError({ code: 'SpawningFailure' }));
      const result = await this.subject.computeLinePeg(file, currentLine);
      expect(result).to.eql({ line: currentLine });
    });
  });
});
