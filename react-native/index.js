'use strict'
// Physical entry point for `import ... from 'nohmo/react-native'`.
//
// The root package.json maps that subpath through "exports", which Node and
// newer bundlers honour. Metro does not: unstable_enablePackageExports is false
// by default in React Native 0.78 and earlier, so it resolves the subpath on
// disk instead — and with nothing here, the import documented in the README
// failed outright on the majority of React Native versions in use.
//
// `./autocapture` already had a shim for the same reason; the main entry never
// got one.
module.exports = require('../dist/react-native.cjs')
