// Logging in through any standard OIDC provider (ORR-664): the authorization code flow with PKCE, found through the
// provider's discovery document, so no provider has code of its own here. The provider says who someone is; what they may
// do stays in orrery's database. Its settings are in the environment, as `settings` goes to backups in plain text.
import {createHash, randomBytes} from 'node:crypto'
import type {H3Event} from 'h3'
import {createRemoteJWKSet, jwtVerify} from 'jose'
import {overHttps} from './auth'
import {originAllowed} from './origins'

interface Provider {
    authorization_endpoint: string
    token_endpoint: string
    jwks_uri: string
    issuer: string
    token_endpoint_auth_methods_supported?: string[]
}

/** How the client's secret goes to the token endpoint (ORR-1181): HTTP Basic, which every provider must take (RFC 6749
 * §2.3.1) and which discovery means when it names none, with the id and secret form-encoded first; in the body only for a
 * provider that names `client_secret_post` and not Basic. */
export function clientAuth(methods: string[] | undefined, clientId: string, clientSecret: string): {headers: Record<string, string>, form: Record<string, string>} {
    if (methods?.includes('client_secret_post') && !methods.includes('client_secret_basic')) return {headers: {}, form: {client_id: clientId, client_secret: clientSecret}}
    const encode = (value: string) => new URLSearchParams({v: value}).toString().slice(2)
    return {headers: {Authorization: `Basic ${Buffer.from(`${encode(clientId)}:${encode(clientSecret)}`).toString('base64')}`}, form: {client_id: clientId}}
}

const COOKIE = 'orrery_oidc'
const COOKIE_PATH = '/api/auth/oidc'
const LOCAL = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/

const settings = () => useRuntimeConfig().oidc as {issuer: string, clientId: string, clientSecret: string}
export const oidcOn = () => {
    const {issuer, clientId, clientSecret} = settings() ?? {}
    return !!(issuer && clientId && clientSecret)
}

/** OIDC stays https-only outside this machine, as the provider's word is what logging in rests on. */
function secure(url: string): string {
    const {protocol, hostname} = new URL(url)
    if (protocol !== 'https:' && !(protocol === 'http:' && LOCAL.test(hostname))) throw createError({statusCode: 500, statusMessage: 'The OIDC provider has to be on https'})
    return url
}

let found: {issuer: string, provider: Provider, at: number} | undefined
async function provider(): Promise<Provider> {
    const issuer = settings().issuer.replace(/\/+$/, '')
    if (found?.issuer === issuer && Date.now() - found.at < 3_600_000) return found.provider
    const document = await $fetch<Provider>(`${secure(issuer)}/.well-known/openid-configuration`)
    if (document.issuer.replace(/\/+$/, '') !== issuer) throw createError({statusCode: 502, statusMessage: 'The OIDC provider gives a different issuer from the one set'})
    for (const url of [document.authorization_endpoint, document.token_endpoint, document.jwks_uri]) secure(url)
    found = {issuer, provider: document, at: Date.now()}
    return document
}

const redirectUri = (event: H3Event) => `${getRequestURL(event, {xForwardedHost: true, xForwardedProto: true}).origin}${COOKIE_PATH}/callback`
const random = () => randomBytes(32).toString('base64url')

/** Where to send the browser to log in, with what the way back has to match kept in a short http-only cookie. `back` is
 * the page's own origin when it's hosted on another site, which the callback returns to (ORR-667): only a listed one. */
export async function startOidc(event: H3Event, invite?: string, back?: string): Promise<string> {
    const {authorization_endpoint} = await provider()
    const [state, nonce, verifier] = [random(), random(), random()]
    setCookie(event, COOKIE, Buffer.from(JSON.stringify({state, nonce, verifier, invite, ...back && originAllowed(back) ? {back} : {}})).toString('base64url'),
        {httpOnly: true, sameSite: 'lax', path: COOKIE_PATH, maxAge: 600, secure: overHttps(event)})
    const url = new URL(authorization_endpoint)
    url.search = new URLSearchParams({
        response_type: 'code', scope: 'openid', client_id: settings().clientId, redirect_uri: redirectUri(event), state, nonce,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString()
    return url.toString()
}

const refused = (message: string) => createError({statusCode: 401, statusMessage: 'Unauthorized', message})

/** What `startOidc` kept in its cookie; none when the cookie isn't that, as a browser can send anything. */
function readKept(kept: string): {state: string, nonce: string, verifier: string, invite?: string, back?: string} | undefined {
    try {
        return JSON.parse(Buffer.from(kept, 'base64url').toString()) ?? undefined
    } catch {
        return undefined
    }
}

/** The way back: checks it answers this browser's own request, swaps the code for an ID token, verifies that against the
 * provider's keys, and says who the provider vouches for, which invite this browser came with, and the listed origin
 * its page is on when that's another site's. */
export async function finishOidc(event: H3Event): Promise<{issuer: string, subject: string, invite?: string, back?: string}> {
    const {state, code} = getQuery(event)
    const kept = getCookie(event, COOKIE)
    deleteCookie(event, COOKIE, {path: COOKIE_PATH})
    if (!kept) throw refused('This login has run out: start again')
    const asked = readKept(kept)
    if (!asked || typeof state !== 'string' || state !== asked.state || typeof code !== 'string') throw refused("This login doesn't match the one this browser started")
    const {token_endpoint, jwks_uri, issuer, token_endpoint_auth_methods_supported: methods} = await provider()
    const {clientId, clientSecret} = settings()
    const auth = clientAuth(methods, clientId, clientSecret)
    const {id_token} = await $fetch<{id_token?: string}>(token_endpoint, {
        method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...auth.headers},
        body: new URLSearchParams({grant_type: 'authorization_code', code, redirect_uri: redirectUri(event), ...auth.form, code_verifier: asked.verifier}).toString(),
    })
    if (!id_token) throw refused('The provider gave no ID token')
    const {payload} = await jwtVerify(id_token, createRemoteJWKSet(new URL(jwks_uri)), {issuer, audience: clientId}).catch(() => {
        throw refused("The provider's ID token doesn't check out")
    })
    if (payload.nonce !== asked.nonce || !payload.sub) throw refused("The provider's ID token doesn't check out")
    // With no trailing slash, as the setting's read, so a login is found the same way whichever the provider writes.
    // `back` is checked again, as the list may have changed since the login started.
    const back = asked.back && originAllowed(asked.back) ? asked.back : undefined
    return {issuer: issuer.replace(/\/+$/, ''), subject: payload.sub, ...asked.invite ? {invite: asked.invite} : {}, ...back ? {back} : {}}
}
