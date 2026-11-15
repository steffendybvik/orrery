// A login provider for the sign-up browser spec (ORR-1221): the smallest OIDC provider the server's own flow
// (server/utils/oidc.ts) gets through, so the spec runs the real path, login page to board, with nothing stubbed on
// the orrery's side. It vouches for whichever account the spec last named (`POST /next {sub, name}`), as a person
// would pick theirs at a real provider, and signs its ID tokens with a key made fresh each start.
// `node scripts/e2e-oidc.mjs <port>`; its issuer is `http://localhost:<port>`.
import {createHash, randomBytes} from 'node:crypto'
import {createServer} from 'node:http'
import {exportJWK, generateKeyPair, SignJWT} from 'jose'

const port = Number(process.argv[2])
const issuer = `http://localhost:${port}`
const {publicKey, privateKey} = await generateKeyPair('RS256')
const jwk = {...await exportJWK(publicKey), kid: 'e2e', alg: 'RS256', use: 'sig'}

let next = {sub: 'nobody', name: 'Nobody'}
/** The codes handed out, each good once, with what its token has to say. */
const codes = new Map()

const body = request => new Promise(resolve => {
    let text = ''
    request.on('data', chunk => text += chunk)
    request.on('end', () => resolve(text))
})

const json = (response, status, data) => {
    response.writeHead(status, {'Content-Type': 'application/json'})
    response.end(JSON.stringify(data))
}

createServer(async (request, response) => {
    const url = new URL(request.url, issuer)
    if (url.pathname === '/.well-known/openid-configuration') {
        return json(response, 200, {
            issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
            token_endpoint_auth_methods_supported: ['client_secret_basic'],
        })
    }
    if (url.pathname === '/jwks') return json(response, 200, {keys: [jwk]})
    if (url.pathname === '/next' && request.method === 'POST') {
        next = JSON.parse(await body(request))
        return json(response, 200, next)
    }
    if (url.pathname === '/authorize') {
        const q = url.searchParams
        const code = randomBytes(16).toString('base64url')
        codes.set(code, {...next, nonce: q.get('nonce'), challenge: q.get('code_challenge'), client: q.get('client_id'), redirect: q.get('redirect_uri')})
        const back = new URL(q.get('redirect_uri'))
        back.search = new URLSearchParams({code, state: q.get('state')}).toString()
        response.writeHead(302, {Location: back.toString()})
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
