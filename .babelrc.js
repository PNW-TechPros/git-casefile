const sharedPresets = [];
const cjsify = ['@babel/preset-env', {
  
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
