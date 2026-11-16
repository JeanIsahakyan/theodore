// Adapted from EvanBacon/chat-template (MIT)
// Uniwind: Tailwind v4 classes (`className`) on React Native, from
// src/global.css. It writes uniwind-types.d.ts (committed) on start.
const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

module.exports = withUniwindConfig(config, {
  cssEntryFile: './src/global.css',
  dtsFile: './uniwind-types.d.ts',
});
