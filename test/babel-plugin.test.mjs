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

  // The regression these guard: the plugin used to SKIP injection when the prop was
  // already set. That failure is silent and total — onReady still captures the launch
  // screen, so the app reports exactly one SCREEN_VIEW per session and never another,
  // which reads like "screen tracking sort of works" rather than "screen tracking is off".
  test('composes with an onStateChange the app already passes', () => {
    const out = compile(`
      export default () => (
        <NavigationContainer ref={navRef} onStateChange={handleNav}><Stack /></NavigationContainer>
      )
    `)
    assert.match(out, /__nohmoComposeState\(handleNav\)/,
      "the app's own onStateChange was not composed with Nohmo's")
    assert.match(out, /composeNohmoStateChange/, 'compose helper was not imported')
  })

  test("composes with the app's own onReady, keeping the ref", () => {
    const out = compile(`
      export default () => (
        <NavigationContainer ref={navRef} onReady={() => hideSplash()}><Stack /></NavigationContainer>
      )
    `)
    assert.match(out, /__nohmoComposeReady\(/, "the app's own onReady was not composed")
    assert.match(out, /__nohmoComposeReady\([\s\S]*?navRef\)/,
      'the navigationRef was not threaded into the composed onReady')
  })

  test('both props already set — both are composed, neither is dropped', () => {
    const out = compile(`
      export default () => (
        <NavigationContainer ref={navRef} onStateChange={(s) => log(s)} onReady={boot}>
          <Stack />
        </NavigationContainer>
      )
    `)
    assert.match(out, /__nohmoComposeState\(/, 'onStateChange was not composed')
    assert.match(out, /__nohmoComposeReady\(boot,/, 'onReady was not composed')
    assert.match(out, /log\(s\)/, "the app's own handler was dropped")
  })

  test('no usable ref — onStateChange still composes, onReady is left alone', () => {
    // onReady needs a named ref to read the initial route; a container without one
    // must still get navigation tracking rather than nothing.
    const out = compile(`
      export default () => (
        <NavigationContainer onStateChange={handleNav}><Stack /></NavigationContainer>
      )
    `)
    assert.match(out, /__nohmoComposeState\(handleNav\)/, 'onStateChange was not composed')
    assert.doesNotMatch(out, /__nohmoComposeReady|__nohmoMakeReady/,
      'onReady was wired without a ref to read the route from')
  })

  test('running the plugin over its own output does not nest the wrappers', () => {
    const once  = compile(`
      export default () => (
        <NavigationContainer ref={navRef} onStateChange={handleNav}><Stack /></NavigationContainer>
      )
    `)
    const twice = compile(once)
    assert.doesNotMatch(twice, /__nohmoComposeState\(__nohmoComposeState/,
      'a second pass double-wrapped onStateChange')
  })

  // Matching the literal name `NavigationContainer` meant any app that spelled it
  // differently got zero screen tracking and no signal that anything was wrong.
  test('follows a renamed import', () => {
    const out = compile(`
      import { NavigationContainer as NavContainer } from '@react-navigation/native'
      export default () => <NavContainer ref={navRef}><Stack /></NavContainer>
    `)
    assert.match(out, /__nohmoNavStateChange/, 'a renamed container was not instrumented')
  })

  test("instruments React Navigation 7's createStaticNavigation result", () => {
    const out = compile(`
      import { createStaticNavigation } from '@react-navigation/native'
      const Navigation = createStaticNavigation(RootStack)
      export default () => <Navigation ref={navRef} />
    `)
    assert.match(out, /__nohmoNavStateChange/, 'a static-API container was not instrumented')
  })

  test('static container declared after the JSX that uses it is still found', () => {
    // The declaration is reached after the component body during traversal, so the
    // names have to be collected up front rather than as they are encountered.
    const out = compile(`
      import { createStaticNavigation } from '@react-navigation/native'
      export default function App() { return <Navigation ref={navRef} /> }
      const Navigation = createStaticNavigation(RootStack)
    `)
    assert.match(out, /__nohmoNavStateChange/, 'declaration order changed the outcome')
  })

  test('an unrelated component named like a container is left alone', () => {
    const out = compile(`
      import { Navigation } from './my-ui-kit'
      export default () => <Navigation ref={navRef} onPress={go} />
    `)
    assert.doesNotMatch(out, /__nohmoNavStateChange/,
      'instrumented a component that is not a navigation container')
  })

  test('instrumented navigation output re-parses', () => {
    const out = compile(`
      export default () => (
        <NavigationContainer ref={navRef} onStateChange={(s) => log(s)} onReady={boot}>
          <Stack />
        </NavigationContainer>
      )
    `)
    assert.doesNotThrow(() => transformSync(out, {
      filename: '/app/src/out.js', babelrc: false, configFile: false,
      plugins: ['@babel/plugin-syntax-jsx'],
    }), 'the plugin produced navigation code that will not parse')
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
