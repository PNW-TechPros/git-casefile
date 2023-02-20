const sharedPresets = [];
const cjsify = ['@babel/preset-env', {
  targets: {
    node: '14.0',
  },
  modules: 'cjs',
}];

module.exports = {
  presets: [cjsify, ...sharedPresets],
  plugins: [
    
  ],
  generatorOpts: {
    compact: false,
    comments: false,
    minified: false,
  },
  sourceMap: true,
};
