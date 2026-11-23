// A login provider for the sign-up browser spec (ORR-1221): the smallest OIDC provider the server's own flow
// (server/utils/oidc.ts) gets through, so the spec runs the real path, login page to board, with nothing stubbed on
// the orrery's side. It vouches for whichever account the spec last named (`POST /next {sub, name}`), as a person
// would pick theirs at a real provider, and signs its ID tokens with a key made fresh each start. Like a real one it
// keeps a session of its own (a cookie), so a browser signed in once is vouched for again without asking, until it
// signs out through `end_session_endpoint` (ORR-1319); `prompt=login` shows its login form even then. `GET /seen` says
// what the last sign-out and form were sent, for the spec to check.
// `node scripts/e2e-oidc.mjs <port>`; its issuer is `http://localhost:<port>`.
import {createHash, randomBytes} from 'node:crypto'
import {createServer} from 'node:http'
import {exportJWK, generateKeyPair, SignJWT} from 'jose'

const port = Number(process.argv[2])
const issuer = `http://localhost:${port}`
const {publicKey, privateKey} = await generateKeyPair('RS256')
const jwk = {...await exportJWK(publicKey), kid: 'e2e', alg: 'RS256', use: 'sig'}

let next = {sub: 'nobody', name: 'Nobody'}
/** What the last sign-out was sent, and how many times the login form was shown. */
const seen = {logout: null, forms: 0}
const SESSION = 'e2e_provider_session'
/** The codes handed out, each good once, with what its token has to say. */
const codes = new Map()

const body = request => new Promise(resolve => {
    let text = ''
    request.on('data', chunk => text += chunk)
    request.on('end', () => resolve(text))
})

const sessionOf = request => {
    const raw = (request.headers.cookie ?? '').split(/;\s*/).find(c => c.startsWith(`${SESSION}=`))?.slice(SESSION.length + 1)
    try {
        return raw ? JSON.parse(Buffer.from(raw, 'base64url').toString()) : undefined
    } catch {
        return undefined
    }
}

const escape = text => String(text).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c])

const json = (response, status, data) => {
    response.writeHead(status, {'Content-Type': 'application/json'})
    response.end(JSON.stringify(data))
}

createServer(async (request, response) => {
    const url = new URL(request.url, issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
        return json(response, 200, {
            issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
            token_endpoint_auth_methods_supported: ['client_secret_basic'], end_session_endpoint: `${issuer}/logout`,
        })
    }
    if (url.pathname === '/jwks') return json(response, 200, {keys: [jwk]})
    if (url.pathname === '/next' && request.method === 'POST') {
        next = JSON.parse(await body(request))
        return json(response, 200, next)
    }
    if (url.pathname === '/seen') return json(response, 200, seen)
    if (url.pathname === '/logout') {
        const q = url.searchParams
        seen.logout = Object.fromEntries(q)
        const back = new URL(q.get('post_logout_redirect_uri'))
        if (q.get('state')) back.searchParams.set('state', q.get('state'))
        response.writeHead(302, {Location: back.toString(), 'Set-Cookie': `${SESSION}=; Max-Age=0; Path=/`})
        return response.end()
    }
    if (url.pathname === '/authorize') {
        const q = url.searchParams
        const session = sessionOf(request)
        // Its login form, when asked for (`prompt=login`) even while signed in here. Continuing picks the account the
        // spec last named, as a person types theirs.
        if (q.get('prompt') === 'login' && !q.get('picked')) {
            seen.forms++
            const picked = new URL(url)
            picked.searchParams.set('picked', '1')
            response.writeHead(200, {'Content-Type': 'text/html'})
            return response.end(`<!doctype html><title>Test provider</title><h1>Sign in at the test provider</h1>
                <p>Signed in here as ${escape(session?.name ?? 'nobody')}.</p><a href="${escape(picked.pathname + picked.search)}">Continue as ${escape(next.name)}</a>`)
        }
        // Without a session of its own, the account the spec last named; with one, that account again, unasked.
        const who = q.get('picked') || !session ? next : session
        const code = randomBytes(16).toString('base64url')
        codes.set(code, {...who, nonce: q.get('nonce'), challenge: q.get('code_challenge'), client: q.get('client_id'), redirect: q.get('redirect_uri')})
        const back = new URL(q.get('redirect_uri'))
        back.search = new URLSearchParams({code, state: q.get('state')}).toString()
        const kept = Buffer.from(JSON.stringify({sub: who.sub, name: who.name})).toString('base64url')
        response.writeHead(302, {Location: back.toString(), 'Set-Cookie': `${SESSION}=${kept}; Path=/; HttpOnly; SameSite=Lax`})
        return response.end()
    }
    if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(await body(request))
        const asked = codes.get(form.get('code'))
        codes.delete(form.get('code'))
        const verifier = form.get('code_verifier') ?? ''
        if (!asked || asked.redirect !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== asked.challenge) {
            return json(response, 400, {error: 'invalid_grant'})
        }
        const id_token = await new SignJWT({nonce: asked.nonce, name: asked.name})
            .setProtectedHeader({alg: 'RS256', kid: 'e2e'})
            .setIssuer(issuer).setAudience(asked.client).setSubject(asked.sub).setIssuedAt().setExpirationTime('5m')
            .sign(privateKey)
        return json(response, 200, {id_token, token_type: 'Bearer', access_token: randomBytes(16).toString('base64url')})
    }
    response.writeHead(404)
    response.end()
}).listen(port, () => console.log(`[e2e-oidc] ${issuer}`))
