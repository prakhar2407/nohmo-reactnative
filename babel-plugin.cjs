'use strict'

/**
 * Nohmo Babel plugin — React Native autocapture.
 *
 * Automatically tracks:
 *  - onPress / onLongPress on any component
 *  - Screen views via NavigationContainer (onStateChange + onReady injected)
 *
 * Usage (babel.config.js):
 *   plugins: ['nohmo/babel-plugin']
 */

const PRESS_PROPS = new Set(['onPress', 'onLongPress'])
const WRAP_ID = '__nohmoWrap'
const NAV_STATE_ID = '__nohmoNavStateChange'
const NAV_READY_ID = '__nohmoMakeReady'
const NAV_COMPOSE_STATE_ID = '__nohmoComposeState'
const NAV_COMPOSE_READY_ID = '__nohmoComposeReady'

// Packages a navigation container can be imported from. `native` is the usual one;
// `@react-navigation/core` re-exports the same component for custom setups.
const NAV_PACKAGES = new Set(['@react-navigation/native', '@react-navigation/core'])
const IMPORT_SOURCE = 'nohmo/react-native/autocapture'

// Stop collecting after this many text fragments — keeps the injected
// expression small for deeply-nested buttons (runtime also caps the string).
const MAX_FRAGMENTS = 6

/**
 * True if an expression node contains (or may evaluate to) JSX — e.g. a badge
 * `{count > 0 ? <View/> : null}` nested in a <Text>. Such fragments stringify to
 * "[object Object]" at runtime, so we skip them rather than capture noise.
 * Walks generically via VISITOR_KEYS so all expression shapes are covered.
 */
function containsJSX(node, t) {
  if (!node || typeof node.type !== 'string') return false
  if (t.isJSXElement(node) || t.isJSXFragment(node)) return true
  const keys = t.VISITOR_KEYS[node.type] || []
  for (const key of keys) {
    const v = node[key]
    if (Array.isArray(v)) {
      for (const c of v) if (containsJSX(c, t)) return true
    } else if (v && typeof v.type === 'string') {
      if (containsJSX(v, t)) return true
    }
  }
  return false
}

/**
 * Walk JSX children and collect text fragments into `out`. A fragment is either
 * a string literal (static JSXText or a "..."-valued expression) or a dynamic
 * expression node (variable / i18n t() call / ternary / template string).
 * Descends into intrinsics and <Text>, but skips other custom components —
 * mirroring how the original static extractor scoped its walk.
 */
function collectFragments(children, t, out) {
  for (const child of children) {
    if (out.length >= MAX_FRAGMENTS) return
    if (t.isJSXText(child)) {
      const v = child.value.replace(/\s+/g, ' ').trim()
      if (v) out.push(t.stringLiteral(v))
    } else if (t.isJSXExpressionContainer(child)) {
      const e = child.expression
      if (t.isStringLiteral(e)) {
        const v = e.value.replace(/\s+/g, ' ').trim()
        if (v) out.push(t.stringLiteral(v))
      } else if (t.isExpression(e) && !t.isJSXEmptyExpression(e) && !containsJSX(e, t)) {
        out.push(e)
      }
    } else if (t.isJSXElement(child)) {
      // Descend into any child component (not just <Text>) so text wrapped in
      // a design-system component — <AppText>, <ThemedText>, etc. — is read.
      collectFragments(child.children, t, out)
    }
  }
}

/**
 * Build an AST node for a JSX element's child text:
 *  - all-static  → one trimmed string literal (≤60 chars)
 *  - any dynamic → a template literal joining each fragment with spaces, so
 *                  i18n / variable / emoji+label children resolve at runtime
 *  - no text     → null
 */
function textNodeFromChildren(children, t) {
  const frags = []
  collectFragments(children, t, frags)
  if (frags.length === 0) return null

  if (frags.every((f) => t.isStringLiteral(f))) {
    const joined = frags.map((f) => f.value).join(' ').replace(/\s+/g, ' ').trim()
    return joined ? t.stringLiteral(joined.slice(0, 60)) : null
  }

  // Template literal needs (expressions + 1) quasis; separate fragments with a
  // single space, empty at the ends. Clone fragments to avoid AST aliasing.
  const quasis = []
  for (let i = 0; i <= frags.length; i++) {
    const raw = i === 0 || i === frags.length ? '' : ' '
    quasis.push(t.templateElement({ raw, cooked: raw }, i === frags.length))
  }
  return t.templateLiteral(quasis, frags.map((f) => t.cloneNode(f, true)))
}

// Text-bearing props, in priority order. Many design-system buttons (and RN's
// core <Button />) carry their label in a prop rather than children.
const TEXT_PROPS = ['label', 'title', 'text', 'accessibilityLabel']

/**
 * Find a text-bearing prop on a JSX element and return an AST node for its value.
 * Static strings become a string literal; dynamic expressions (i18n t() calls,
 * ternaries, template strings) are cloned and embedded so they evaluate at
 * runtime — capturing the label the user actually sees. Returns null if none.
 * The clone matters: aliasing the original prop node breaks Hermes codegen.
 */
function textFromProps(attrs, t) {
  for (const propName of TEXT_PROPS) {
    const attr = attrs.find(
      (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === propName
    )
    if (!attr) continue
    if (t.isStringLiteral(attr.value)) {
      const v = attr.value.value.replace(/\s+/g, ' ').trim()
      if (v) return t.stringLiteral(v.slice(0, 60))
    }
    if (t.isJSXExpressionContainer(attr.value)) {
      const expr = attr.value.expression
      if (t.isExpression(expr) && !t.isJSXEmptyExpression(expr) && !containsJSX(expr, t)) {
        return t.cloneNode(expr, true)
      }
    }
  }
  return null
}

// Common icon component families (react-native-vector-icons / @expo/vector-icons).
const ICON_SETS = new Set([
  'Ionicons', 'MaterialIcons', 'MaterialCommunityIcons', 'FontAwesome', 'FontAwesome5',
  'FontAwesome6', 'Feather', 'AntDesign', 'Entypo', 'EvilIcons', 'Foundation',
  'Octicons', 'SimpleLineIcons', 'Zocial', 'Fontisto',
])

function isIconComponent(name) {
  return !!name && (ICON_SETS.has(name) || /icon/i.test(name))
}

/**
 * Last-resort fallback for icon-only buttons (trash / menu / close): find the
 * first icon-like child and use its `name` prop as the label, so the button is
 * still identifiable. Static names embed directly; dynamic ones run at runtime.
 */
function iconNameFromChildren(children, t) {
  for (const child of children) {
    if (!t.isJSXElement(child)) continue
    const namePart = child.openingElement.name
    const cname = t.isJSXIdentifier(namePart) ? namePart.name : null
    if (isIconComponent(cname)) {
      const nameAttr = child.openingElement.attributes.find(
        (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === 'name'
      )
      if (nameAttr) {
        if (t.isStringLiteral(nameAttr.value)) {
          const v = nameAttr.value.value.trim()
          if (v) return t.stringLiteral(v.slice(0, 60))
        } else if (t.isJSXExpressionContainer(nameAttr.value)) {
          const e = nameAttr.value.expression
          if (t.isExpression(e) && !t.isJSXEmptyExpression(e) && !containsJSX(e, t)) {
            return t.cloneNode(e, true)
          }
        }
      }
    }
    const inner = iconNameFromChildren(child.children, t)
    if (inner) return inner
  }
  return null
}

module.exports = function nohmoPlugin({ types: t }) {
  return {
    visitor: {
      Program: {
        /**
         * Work out what this file actually calls its navigation container, before any
         * JSX is visited.
         *
         * Matching the literal name `NavigationContainer` was too brittle: a renamed
         * import (`NavigationContainer as NavContainer`) or React Navigation 7's
         * `createStaticNavigation` both produce a container under a different name, and
         * the plugin then instrumented nothing at all — silently, which is the failure
         * mode that matters. Resolving the binding instead means we follow the import,
         * not the spelling.
         */
        enter(programPath, state) {
          // The bare name stays in the set so a container imported in some way we don't
          // model — or re-exported through a local module — still matches as before.
          state.nohmoContainers = new Set(['NavigationContainer'])
          const staticFactories = new Set()

          for (const node of programPath.node.body) {
            if (!t.isImportDeclaration(node)) continue
            if (!NAV_PACKAGES.has(node.source.value)) continue
            for (const spec of node.specifiers) {
              if (!t.isImportSpecifier(spec) || !t.isIdentifier(spec.imported)) continue
              if (spec.imported.name === 'NavigationContainer') {
                state.nohmoContainers.add(spec.local.name)
              } else if (spec.imported.name === 'createStaticNavigation') {
                staticFactories.add(spec.local.name)
              }
            }
          }

          // `const Navigation = createStaticNavigation(RootStack)` — the result takes the
          // same ref/onStateChange/onReady props, so it is a container for our purposes.
          // Collected up front rather than in a VariableDeclarator visitor, because the
          // JSX that uses it can be traversed before the declaration is reached.
          if (staticFactories.size > 0) {
            programPath.traverse({
              VariableDeclarator(declPath) {
                const { id, init } = declPath.node
                if (!t.isIdentifier(id) || !t.isCallExpression(init)) return
                if (!t.isIdentifier(init.callee) || !staticFactories.has(init.callee.name)) return
                state.nohmoContainers.add(id.name)
              },
            })
          }
        },

        // Inject a single import statement at the top of any file we touched
        exit(programPath, state) {
          const specifiers = []

          if (state.nohmoWrapUsed) {
            specifiers.push(
              t.importSpecifier(t.identifier(WRAP_ID), t.identifier(WRAP_ID))
            )
          }
          // Granular, so a file that only composes doesn't also import the two
          // direct handlers it never references.
          if (state.nohmoNavState) {
            specifiers.push(
              t.importSpecifier(t.identifier(NAV_STATE_ID), t.identifier('onNohmoStateChange'))
            )
          }
          if (state.nohmoNavReady) {
            specifiers.push(
              t.importSpecifier(t.identifier(NAV_READY_ID), t.identifier('makeNohmoReadyHandler'))
            )
          }
          if (state.nohmoNavComposeState) {
            specifiers.push(
              t.importSpecifier(t.identifier(NAV_COMPOSE_STATE_ID), t.identifier('composeNohmoStateChange'))
            )
          }
          if (state.nohmoNavComposeReady) {
            specifiers.push(
              t.importSpecifier(t.identifier(NAV_COMPOSE_READY_ID), t.identifier('composeNohmoReady'))
            )
          }

          if (specifiers.length > 0) {
            programPath.unshiftContainer(
              'body',
              t.importDeclaration(specifiers, t.stringLiteral(IMPORT_SOURCE))
            )
          }
        },
      },

      JSXOpeningElement(path, state) {
        if (state.filename && state.filename.includes('node_modules')) return

        const attrs = path.node.attributes
        const nameNode = path.node.name
        const componentName = t.isJSXIdentifier(nameNode) ? nameNode.name : null

        // ── NavigationContainer: inject onStateChange + onReady ────────────
        if (componentName && state.nohmoContainers && state.nohmoContainers.has(componentName)) {
          const findAttr = (name) =>
            attrs.find(
              (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name) && a.name.name === name
            )

          // Recognises our own output, so a second visit can't nest
          // __nohmoComposeState(__nohmoComposeState(fn)).
          const alreadyOurs = (expr) =>
            t.isIdentifier(expr, { name: NAV_STATE_ID }) ||
            (t.isCallExpression(expr) &&
              t.isIdentifier(expr.callee) &&
              [NAV_READY_ID, NAV_COMPOSE_STATE_ID, NAV_COMPOSE_READY_ID].includes(expr.callee.name))

          // The navigationRef, needed to read the initial route in onReady. Only a plain
          // Identifier (ref={navigationRef}) is usable — a callback or inline ref has no
          // name the injected call could reference.
          const refAttr = findAttr('ref')
          const refExpr =
            refAttr &&
            t.isJSXExpressionContainer(refAttr.value) &&
            t.isIdentifier(refAttr.value.expression)
              ? refAttr.value.expression
              : null

          // ── onStateChange ──────────────────────────────────────────────────
          // Absent: inject ours. Already set: COMPOSE with it. This used to bail, which
          // was silent and total — the app kept the single SCREEN_VIEW that onReady
          // captures at startup and never got another for the rest of the session. An
          // app that passes its own onStateChange (its own analytics, a title sync) is
          // common, so the bail hit exactly the apps already thinking about navigation.
          const stateAttr = findAttr('onStateChange')
          if (!stateAttr) {
            attrs.push(
              t.jsxAttribute(
                t.jsxIdentifier('onStateChange'),
                t.jsxExpressionContainer(t.identifier(NAV_STATE_ID))
              )
            )
            state.nohmoNavState = true
          } else if (t.isJSXExpressionContainer(stateAttr.value)) {
            const userExpr = stateAttr.value.expression
            if (t.isExpression(userExpr) && !alreadyOurs(userExpr)) {
              stateAttr.value.expression = t.callExpression(
                t.identifier(NAV_COMPOSE_STATE_ID),
                [userExpr]
              )
              state.nohmoNavComposeState = true
            }
          }

          // ── onReady ────────────────────────────────────────────────────────
          // Deep-clone the ref node — reusing the same AST node in two positions causes
          // malformed code generation on Hermes (ReferenceError: Property 'X' doesn't exist).
          if (refExpr) {
            const readyAttr = findAttr('onReady')
            if (!readyAttr) {
              attrs.push(
                t.jsxAttribute(
                  t.jsxIdentifier('onReady'),
                  t.jsxExpressionContainer(
                    t.callExpression(t.identifier(NAV_READY_ID), [t.cloneNode(refExpr, true)])
                  )
                )
              )
              state.nohmoNavReady = true
            } else if (t.isJSXExpressionContainer(readyAttr.value)) {
              const userExpr = readyAttr.value.expression
              if (t.isExpression(userExpr) && !alreadyOurs(userExpr)) {
                readyAttr.value.expression = t.callExpression(
                  t.identifier(NAV_COMPOSE_READY_ID),
                  [userExpr, t.cloneNode(refExpr, true)]
                )
                state.nohmoNavComposeReady = true
              }
            }
          }

          return // NavigationContainer handled — skip press wrapping below
        }

        // ── Press props: wrap onPress / onLongPress ────────────────────────
        if (componentName && /^[a-z]/.test(componentName)) return // skip intrinsics

        const pressAttrs = attrs.filter(
          (attr) =>
            t.isJSXAttribute(attr) &&
            t.isJSXIdentifier(attr.name) &&
            PRESS_PROPS.has(attr.name.name)
        )
        if (pressAttrs.length === 0) return

        const parentNode = path.parentPath?.node
        const children =
          parentNode && t.isJSXElement(parentNode) ? parentNode.children : []
        // Fallback order: visible children text (static or dynamic) → a
        // text-bearing prop → an icon child's name (icon-only buttons). Dynamic
        // children/prop/name expressions are embedded for runtime evaluation, so
        // i18n / ternary / template / emoji+label labels capture as displayed.
        const textNode =
          textNodeFromChildren(children, t) ||
          textFromProps(attrs, t) ||
          iconNameFromChildren(children, t) ||
          t.nullLiteral()

        const filename = state.filename
          ? state.filename.replace(/.*[/\\]/, '').replace(/\.[jt]sx?$/, '')
          : null
        const line = path.node.loc?.start.line ?? null

        for (const attr of pressAttrs) {
          if (!t.isJSXAttribute(attr)) continue
          if (!t.isJSXExpressionContainer(attr.value)) continue
          const expr = attr.value.expression
          if (!t.isExpression(expr) || t.isJSXEmptyExpression(expr)) continue

          const metaProps = [
            t.objectProperty(t.identifier('c'), componentName ? t.stringLiteral(componentName) : t.nullLiteral()),
            t.objectProperty(t.identifier('p'), t.stringLiteral(attr.name.name)),
            t.objectProperty(t.identifier('t'), t.cloneNode(textNode, true)),
            t.objectProperty(t.identifier('f'), filename ? t.stringLiteral(filename) : t.nullLiteral()),
          ]
          if (line !== null) {
            metaProps.push(t.objectProperty(t.identifier('l'), t.numericLiteral(line)))
          }

          attr.value = t.jsxExpressionContainer(
            t.callExpression(t.identifier(WRAP_ID), [expr, t.objectExpression(metaProps)])
          )
          state.nohmoWrapUsed = true
        }
      },
    },
  }
}
