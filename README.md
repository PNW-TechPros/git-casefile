# git-casefile Package

[Casefile][casefile] was a dogfooded test-bed for a new kind of bookmarking system built for the Atom text editor.  Now that the Atom editor is dead, `git-casefile` aims to refactor the functionality of `casefile` into a package consumable by other editors, primarily VS Code.

## Installation

```console
$ npm install --save-prod git-casefile

or 

$ yarn add git-casefile
```

## Documentation

Our documentation is available [here](https://PNW-TechPros.github.io/git-casefile).  It includes all published versions.

The entrypoint for the package documentation is the *git-casefile* module and its *CasefileKeeper* class.

## Getting Started

### CommonJS

```js
const { CasefileKeeper } = require('git-casefile');

const cfKeeper = new CasefileKeeper({
  // Pass a "cwd" prop here if needed
});

// Use cfKeeper to access remotes, load casefiles, or recover deleted casefiles.

// Use cfKeeper.bookmarks to find the current location for a bookmark or compute
// the "peg" location of a new bookmark.
```

### ES Module

```js
import { CasefileKeeper } from 'git-casefile';

const cfKeeper = new CasefileKeeper({
  // Pass a "cwd" prop here if needed
});

// Use cfKeeper to access remotes, load casefiles, or recover deleted casefiles.

// Use cfKeeper.bookmarks to find the current location for a bookmark or compute
// the "peg" location of a new bookmark.
```

[casefile]: https://github.com/rtweeks/casefile
