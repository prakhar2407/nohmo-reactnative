/**
 * Tests for the Nohmo Babel plugin — React Native press autocapture.
 *
 * The plugin is what produces PRESS / LONG_PRESS / RAGE_CLICK on React Native:
 * it rewrites every onPress at build time. That makes it the one piece of the
 * SDK whose output nobody ever reads, in an app nobody inspects the build of —
 * so a regression here is invisible until presses quietly stop arriving.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformSync } from '@babel/core'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plugin = path.join(repo, 'babel-plugin.cjs')

function compile(code, filename = '/app/src/CheckoutScreen.js') {
  return transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    plugins: ['@babel/plugin-syntax-jsx', plugin],
  }).code
}

describe('babel plugin — press capture', () => {
  test('wraps onPress and carries the static label', () => {
    const out = compile(`
      export default () => (
        <Pressable onPress={handleBuy}><Text>Buy now</Text></Pressable>
      )
    `)
    assert.match(out, /__nohmoWrap\(/, 'onPress was not wrapped')
    assert.match(out, /handleBuy/)
    assert.match(out, /Buy now/, 'the button label was not captured')
    assert.match(out, /nohmo\/react-native\/autocapture/, 'no import injected')
  })

  test('captures the component name, file and line', () => {
    const out = compile(`<Pressable onPress={go}><Text>Pay</Text></Pressable>`)
    assert.match(out, /c:\s*"Pressable"/, 'component name missing')
    // file+line is what Silent Failures shows for a dead press.
    assert.match(out, /f:\s*"CheckoutScreen"/, 'filename missing')
    assert.match(out, /l:\s*\d+/, 'line number missing')
  })

  test('wraps onLongPress too', () => {
    const out = compile(`<Pressable onLongPress={hold}><Text>Hold</Text></Pressable>`)
    assert.match(out, /__nohmoWrap\(/)
    assert.match(out, /p:\s*"onLongPress"/)
  })

  test('leaves onPressIn / onPressOut alone', () => {
    // Deliberately excluded — they fire on every touch and would swamp the
    // press signal.
    const out = compile(`
      <Pressable onPressIn={a} onPressOut={b}><Text>x</Text></Pressable>
    `)
    assert.doesNotMatch(out, /__nohmoWrap\(/)
  })

  test('does not touch files inside node_modules', () => {
    const out = compile(
      `<Pressable onPress={x}><Text>lib</Text></Pressable>`,
      '/app/node_modules/some-ui-kit/Button.js')
    assert.doesNotMatch(out, /__nohmoWrap\(/,
      "a dependency's internals must not be rewritten")
  })

  test('a file with no press handlers is left unmodified', () => {
    const out = compile(`export const x = <View><Text>hi</Text></View>`)
    assert.doesNotMatch(out, /nohmo/, 'injected an import into an untouched file')
  })

  test('reads a label from an accessibilityLabel or title prop', () => {
    const out = compile(`<Button title="Place order" onPress={go} />`)
    assert.match(out, /Place order/)
  })

  test('handles an inline arrow handler', () => {
    const out = compile(`<Pressable onPress={() => doThing()}><Text>Go</Text></Pressable>`)
    assert.match(out, /__nohmoWrap\(/)
    assert.match(out, /doThing/)
  })
})

describe('babel plugin — navigation', () => {
  test('injects screen tracking into NavigationContainer', () => {
    const out = compile(`
      export default () => (
        <NavigationContainer ref={navRef}><Stack /></NavigationContainer>
      )
    `)
    // Without this, screen views need wiring by hand in every app.
    assert.match(out, /onStateChange|__nohmoNavStateChange/,
      'NavigationContainer was not instrumented')
  })
})

describe('babel plugin — output is valid', () => {
  test('transformed output re-parses', () => {
    const out = compile(`
      export default function Screen() {
        return (
          <View>
            <Pressable onPress={a}><Text>One</Text></Pressable>
            <Pressable onLongPress={b}><Text>Two</Text></Pressable>
          </View>
        )
      }
    `)
    assert.doesNotThrow(() => transformSync(out, {
      filename: '/app/src/out.js', babelrc: false, configFile: false,
      plugins: ['@babel/plugin-syntax-jsx'],
    }), 'the plugin produced code that will not parse')
  })
})
