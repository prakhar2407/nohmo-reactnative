/**
 * Tests for the Node server SDK, run against the BUILT bundle (dist/server.cjs), not
 * the TypeScript source — so packaging mistakes (a bad exports map, a node built-in that
 * got shimmed away) fail here rather than in a customer's app.
 *
 *   node test/server.test.mjs
 */
import http from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const nohmo = require('../dist/server.cjs')

let pass = 0
const fails = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fails.push(name); console.log(`  FAIL  ${name}\n        ${detail}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── a real HTTP server standing in for the ingest endpoint ──────────────────
let received = []
let respondWith = { status: 200, body: '{"success":true}' }
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    received.push({ headers: req.headers, body, url: req.url, method: req.method })
    res.writeHead(respondWith.status, { 'Content-Type': 'application/json',
      ...(respondWith.retryAfter ? { 'Retry-After': respondWith.retryAfter } : {}) })
    res.end(respondWith.body)
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ENDPOINT = `http://127.0.0.1:${server.address().port}/api/tracker/track/`
const reset = () => { received = []; respondWith = { status: 200, body: '{"success":true}' } }

console.log('=== the package exports what the docs promise ===')
for (const fn of ['init', 'captureException', 'captureMessage', 'flush', 'close',
                  'isInitialised', 'expressErrorHandler', 'wrapHandler', 'ServerClient']) {
  check(`exports ${fn}`, typeof nohmo[fn] === 'function' || typeof nohmo[fn] === 'object')
}

console.log('\n=== init is forgiving: a missing key must never stop a deploy ===')
check('init() with no key returns null', nohmo.init({ projectId: 'p', apiKey: '' }) === null)
check('isInitialised() is false', nohmo.isInitialised() === false)
check('captureException before init is a no-op (does not throw)',
  (() => { try { nohmo.captureException(new Error('x')); return true } catch { return false } })())
check('flush() before init resolves true', await nohmo.flush(100) === true)

console.log('\n=== the wire format matches Python and the browser SDK ===')
reset()
nohmo.init({ projectId: 'proj_test', apiKey: 'pk_test', endpoint: ENDPOINT,
             environment: 'test', release: '1.2.3', flushInterval: 60, dedupWindow: 0 })
nohmo.captureException(new TypeError('node boom'), { request: { path: '/a', method: 'GET' } })
check('flush() resolves true', await nohmo.flush(3000) === true)
check('exactly one request was made', received.length === 1, received.length)
const payload = JSON.parse(received[0].body)
const ev = payload.events[0]
check('apiKey is in the body', payload.apiKey === 'pk_test')
check('X-API-Key header is set', received[0].headers['x-api-key'] === 'pk_test')
check('User-Agent identifies the SDK',
  /^nohmo-node\/\d+\.\d+\.\d+$/.test(received[0].headers['user-agent'] || ''),
  received[0].headers['user-agent'])
check('no Content-Encoding (the server cannot decompress)',
  !received[0].headers['content-encoding'], received[0].headers['content-encoding'])
check("event is SERVER_ERROR", ev.event === 'SERVER_ERROR', ev.event)
check("platform is server", ev.platform === 'server', ev.platform)
check('sessionId is EMPTY without a correlation id (no phantom sessions)',
  ev.sessionId === '', JSON.stringify(ev.sessionId))
check('deviceId identifies the process', /^server:.+:\d+$/.test(ev.deviceId), ev.deviceId)
check('message includes the error type', ev.data.message === 'TypeError: node boom', ev.data.message)
check('stack is attached', typeof ev.data.stack === 'string' && ev.data.stack.includes('at '))
check('environment tag survives', ev.data.environment === 'test')
check('release tag survives', ev.data.release === '1.2.3')
check('runtime is reported', /^node\//.test(ev.data.runtime), ev.data.runtime)
check('page is the request path', ev.page === '/a', ev.page)
check('ts is epoch millis', ev.ts > 1e12 && ev.ts < 2e13, ev.ts)

console.log('\n=== a correlation id becomes the session, so traces line up ===')
reset()
nohmo.captureException(new Error('with rid'), { request: { path: '/b', requestId: 'req-42' } })
await nohmo.flush(3000)
check('sessionId is the request id', JSON.parse(received[0].body).events[0].sessionId === 'req-42')

console.log('\n=== PII is withheld unless explicitly enabled ===')
reset()
nohmo.captureException(new Error('pii'), {
  request: { path: '/c', headers: { authorization: 'Bearer secret', 'x-api-key': 'k' },
             query: { token: 'abc' }, ip: '1.2.3.4' },
  user: { id: 7, email: 'a@b.com' },
})
await nohmo.flush(3000)
const d = JSON.parse(received[0].body).events[0]
check('headers withheld', d.data.headers === undefined)
check('query withheld', d.data.query === undefined)
check('ip withheld', d.data.ip === undefined)
check('email withheld', d.data.userEmail === undefined)
check('userId IS sent (not PII on its own)', d.userId === '7', d.userId)

console.log('\n=== with sendDefaultPii on, credentials are still redacted ===')
await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, sendDefaultPii: true,
             flushInterval: 60, dedupWindow: 0 })
nohmo.captureException(new Error('pii2'), {
  request: { path: '/d',
             headers: { 'X-API-Key': 'leak', 'Set-Cookie': 'a=b', 'Proxy-Authorization': 'z',
                        'user-agent': 'curl' },
             query: { access_token: 'leak', page: '2' } },
  user: { email: 'a@b.com' },
})
await nohmo.flush(3000)
const p2 = JSON.parse(received[0].body).events[0]
for (const k of ['X-API-Key', 'Set-Cookie', 'Proxy-Authorization']) {
  check(`${k} is redacted`, p2.data.headers[k] === '[redacted]', JSON.stringify(p2.data.headers[k]))
}
check('a harmless header survives', p2.data.headers['user-agent'] === 'curl')
check('access_token in the query is redacted', p2.data.query.access_token === '[redacted]')
check('a harmless query param survives', p2.data.query.page === '2')
check('email IS sent when PII is on', p2.data.userEmail === 'a@b.com')

console.log('\n=== batching, dedup and the bounded queue ===')
await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60,
             dedupWindow: 60, batchSize: 1000 })
for (let i = 0; i < 5; i++) nohmo.captureException(new Error('same error'))
await nohmo.flush(3000)
const n = received.length ? JSON.parse(received[0].body).events.length : 0
check('5 identical errors dedup to 1 within the window', n === 1, n)

await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60,
             dedupWindow: 0, batchSize: 10 })
for (let i = 0; i < 25; i++) nohmo.captureException(new Error(`distinct ${i}`))
await nohmo.flush(3000)
const total = received.reduce((s, r) => s + JSON.parse(r.body).events.length, 0)
check('25 distinct errors all sent', total === 25, total)
check('split into batches of 10', received.every((r) => JSON.parse(r.body).events.length <= 10),
  received.map((r) => JSON.parse(r.body).events.length))

await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60,
             dedupWindow: 0, queueSize: 10, batchSize: 1000 })
for (let i = 0; i < 50; i++) nohmo.captureException(new Error(`flood ${i}`))
await nohmo.flush(3000)
const kept = received.reduce((s, r) => s + JSON.parse(r.body).events.length, 0)
check('queue is bounded — a crash loop cannot OOM the app', kept <= 10, kept)
const msgs = received.flatMap((r) => JSON.parse(r.body).events.map((e) => e.data.message))
check('the NEWEST errors are kept, not the oldest', msgs.some((m) => m.includes('flood 49')), msgs)

console.log('\n=== anything can be thrown in JS ===')
await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60, dedupWindow: 0 })
nohmo.captureException('a bare string')
nohmo.captureException({ name: 'CustomError', message: 'an object' })
nohmo.captureException(null)
nohmo.captureException(42)
await nohmo.flush(3000)
const thrown = received.flatMap((r) => JSON.parse(r.body).events)
check('all four odd throws were reported', thrown.length === 4, thrown.length)
check('string throw keeps its text', thrown.some((e) => e.data.message === 'a bare string'))
check('object throw keeps name+message',
  thrown.some((e) => e.data.type === 'CustomError' && e.data.message === 'an object'))
check('null throw does not crash', thrown.some((e) => e.data.message === 'null'))

console.log('\n=== server errors are handled, not thrown at the app ===')
await nohmo.close(1000)
reset(); respondWith = { status: 401, body: 'no' }
nohmo.init({ projectId: 'p', apiKey: 'bad', endpoint: ENDPOINT, flushInterval: 60, dedupWindow: 0 })
nohmo.captureException(new Error('401 path'))
check('flush() reports failure rather than throwing', await nohmo.flush(3000) === false)
check('401 is not retried', received.length === 1, received.length)

await nohmo.close(1000)
reset(); respondWith = { status: 500, body: 'boom' }
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60,
             dedupWindow: 0 })
nohmo.captureException(new Error('500 path'))
check('500 fails after retrying', await nohmo.flush(15000) === false)
check('500 WAS retried', received.length > 1, received.length)

console.log('\n=== an unreachable host is reported, not swallowed ===')
await nohmo.close(1000)
const warnings = []
const realWarn = console.warn
console.warn = (m) => warnings.push(String(m))
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: 'http://127.0.0.1:1/track',
             flushInterval: 60, dedupWindow: 0 })
nohmo.captureException(new Error('nowhere'))
await nohmo.flush(20000)
console.warn = realWarn
check('warns that events are being dropped',
  warnings.some((w) => w.includes('cannot reach') && w.includes('dropped')), warnings)

console.log('\n=== express integration ===')
await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60, dedupWindow: 0 })
const handler = nohmo.expressErrorHandler()
check('handler declares 4 args (Express detects error handlers by arity)',
  handler.length === 4, handler.length)
let passedOn = null
handler(new Error('express boom'),
  { originalUrl: '/orders/9?x=1', method: 'POST', headers: { 'x-request-id': 'rid-1' },
    user: { id: 3, email: 'u@e.com' } },
  {}, (e) => { passedOn = e })
await nohmo.flush(3000)
check('the error is passed on, never swallowed', passedOn instanceof Error, passedOn)
const xe = JSON.parse(received[0].body).events[0]
check('path uses originalUrl with the query stripped', xe.page === '/orders/9', xe.page)
check('marked unhandled', xe.data.handled === false)
check('x-request-id becomes the session', xe.sessionId === 'rid-1', xe.sessionId)
check('user id captured from req.user', xe.userId === '3', xe.userId)

console.log('\n=== shouldReport can suppress expected errors ===')
reset()
const filtered = nohmo.expressErrorHandler({ shouldReport: (e) => e.status !== 404 })
let cont = null
const notFound = Object.assign(new Error('nope'), { status: 404 })
filtered(notFound, { originalUrl: '/x', headers: {} }, {}, (e) => { cont = e })
await nohmo.flush(500)
check('404 suppressed', received.length === 0, received.length)
check('but still passed down the chain', cont === notFound)

console.log('\n=== raw node:http wrapper ===')
reset()
const wrapped = nohmo.wrapHandler(async () => { throw new Error('async boom') })
let rethrew = false
try { await wrapped({ url: '/api/x?q=1', method: 'GET', headers: {}, socket: {} }, {}) }
catch { rethrew = true }
await nohmo.flush(3000)
check('async rejection is rethrown (never leave the socket hanging)', rethrew)
check('and reported', received.length === 1, received.length)
check('query stripped from the path',
  JSON.parse(received[0].body).events[0].page === '/api/x')

reset()
const syncWrapped = nohmo.wrapHandler(() => { throw new Error('sync boom') })
let syncRethrew = false
try { syncWrapped({ url: '/s', method: 'GET', headers: {}, socket: {} }, {}) }
catch { syncRethrew = true }
await nohmo.flush(3000)
check('sync throw is rethrown', syncRethrew)
check('and reported', received.length === 1, received.length)

reset()
const okWrapped = nohmo.wrapHandler(() => 'fine')
check('a healthy sync handler returns its value untouched',
  okWrapped({ url: '/ok', headers: {}, socket: {} }, {}) === 'fine')
await sleep(50)
check('nothing reported for a healthy request', received.length === 0, received.length)

console.log('\n=== captureMessage ===')
await nohmo.close(1000)
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, environment: 'msg-test',
             flushInterval: 60, dedupWindow: 0 })
nohmo.captureMessage('reconciliation finished with 3 mismatches')
await nohmo.flush(3000)
const cm = received.length ? JSON.parse(received[0].body).events[0] : null
check('captureMessage sends an event', cm !== null, received.length)
check('it is a SERVER_ERROR like everything else', cm?.event === 'SERVER_ERROR', cm?.event)
check('the message text is preserved',
  cm?.data.message === 'reconciliation finished with 3 mismatches', cm?.data.message)
check("type is 'Message', so it groups apart from thrown errors",
  cm?.data.type === 'Message', cm?.data.type)
check('marked handled — nothing crashed', cm?.data.handled === true, cm?.data.handled)
check('no stack is invented', cm?.data.stack === '', JSON.stringify(cm?.data.stack))

reset()
nohmo.captureMessage('with context', {
  request: { path: '/jobs/nightly', requestId: 'job-7' }, extra: { rows: 812 } })
await nohmo.flush(3000)
const cm2 = JSON.parse(received[0].body).events[0]
check('captureMessage honours request context', cm2.page === '/jobs/nightly', cm2.page)
check('and the correlation id', cm2.sessionId === 'job-7', cm2.sessionId)
check('and extra', cm2.data.extra?.rows === 812, JSON.stringify(cm2.data.extra))

console.log('\n=== extra is scrubbed like everything else ===')
reset()
nohmo.captureMessage('creds in extra', { extra: { db_password: 'hunter2', rows: 1 } })
await nohmo.flush(3000)
const ce = JSON.parse(received[0].body).events[0]
check('a secret in extra is redacted', ce.data.extra.db_password === '[redacted]',
  JSON.stringify(ce.data.extra))
check('a harmless key in extra survives', ce.data.extra.rows === 1)

console.log('\n=== getClient ===')
check('getClient() returns the live client after init',
  nohmo.getClient() !== null && typeof nohmo.getClient().captureException === 'function')
check('the client exposes its instance id', /^server:.+:\d+$/.test(nohmo.getClient().instanceId),
  nohmo.getClient()?.instanceId)
check('isInitialised() agrees', nohmo.isInitialised() === true)
await nohmo.close(1000)
check('getClient() is null after close()', nohmo.getClient() === null)
check('isInitialised() is false after close()', nohmo.isInitialised() === false)
check('captureException after close does not throw',
  (() => { try { nohmo.captureException(new Error('post-close')); return true }
           catch { return false } })())

console.log('\n=== a closed client accepts nothing more ===')
reset()
nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60, dedupWindow: 0 })
const c = nohmo.getClient()
await c.close(1000)
c.captureException(new Error('after close'))
await sleep(100)
check('nothing is sent after close()', received.length === 0, received.length)

console.log('\n=== repeated init() must not leak process listeners ===')
{
  await nohmo.close(1000)
  const before = process.listenerCount('beforeExit')
  for (let i = 0; i < 15; i++) {
    nohmo.init({ projectId: 'p', apiKey: 'k', endpoint: ENDPOINT, flushInterval: 60 })
  }
  const after = process.listenerCount('beforeExit')
  check(`15 init() calls add at most one listener (${before} -> ${after})`,
    after - before <= 1, `${before} -> ${after}`)
  await nohmo.close(1000)
  check('close() detaches it again', process.listenerCount('beforeExit') <= before,
    process.listenerCount('beforeExit'))
}

console.log('\n=== the flush timer must never keep a process alive ===')
// A real test, not an assertion of true: spawn a process that inits the SDK and does
// nothing else. If the interval timer is not unref'd, this never exits and the app that
// merely imported the SDK hangs forever on shutdown.
{
  const { spawn } = await import('node:child_process')
  const src = `
    const n = require('${process.cwd()}/dist/server.cjs')
    n.init({ projectId: 'p', apiKey: 'k', endpoint: '${ENDPOINT}', flushInterval: 300 })
    n.captureException(new Error('exit test'))
  `
  const child = spawn(process.execPath, ['-e', src], { stdio: 'ignore' })
  const exited = await Promise.race([
    new Promise((r) => child.on('exit', () => r(true))),
    sleep(6000).then(() => false),
  ])
  if (!exited) child.kill('SIGKILL')
  check('a process that only inits the SDK still exits on its own', exited,
    'it hung — the flush interval is not unref\'d')
}

await nohmo.close(2000)
server.close()
console.log()
console.log(fails.length ? `${fails.length} FAILED of ${pass + fails.length}: ${fails.join(', ')}`
                         : `All ${pass} checks passed.`)
process.exit(fails.length ? 1 : 0)
