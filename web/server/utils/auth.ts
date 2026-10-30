// Who a request is, when auth is on (ORR-664): the one step that turns a credential into rights. Everything after it reads
// `event.context.who` (`actorOf`, `personOf`), so if a provider or a key's grants give rights later, only this changes.
import type {H3Event} from 'h3'
import {inDocker} from './backup-choice'
import {LOOPBACK, proxied} from './move'
import {oidcOn} from './oidc'

/** A checked credential: a person in a browser, or an agent of that person, which can never act as them. */
export interface Who {
    person: string
    owner: boolean
    via: 'browser' | 'agent'
}

export const LOGIN_COOKIE = 'orrery_login'

/** Whether the server listens on loopback alone: outside Docker the address it bound to (a socket's path is `nuxt dev`'s
 * own), and inside it, where every request comes over the bridge, the address compose publishes it on, empty counting as
 * not. A server that can't say is taken as reachable. */
function onLoopback(event: H3Event): boolean {
    if (inDocker()) return LOOPBACK.test(String(useRuntimeConfig().listenHost ?? ''))
    const server = (event.node.req.socket as {server?: {address?: () => unknown}} | undefined)?.server
    const bound = server?.address?.()
    if (typeof bound === 'string') return true
    return LOOPBACK.test(String((bound as {address?: string} | null | undefined)?.address ?? ''))
}

/** Whether ORRERY_AUTH=off is set, for trying people out on one machine. */
const toldOff = () => String(useRuntimeConfig().auth || process.env.ORRERY_AUTH || '').toLowerCase() === 'off'

/** A second person turns auth on, so without a way in that would lock the owner out: they claim the server first. */
export async function needsWayInForPeople() {
    if (toldOff() || await canGetIn()) return
    throw conflict('A second person turns login on, and nobody could log in yet: run `pnpm orrery:claim` on this machine first (or `docker compose exec orrery node /app/server/claim.mjs`). To only try people out on this machine, start orrery with ORRERY_AUTH=off')
}

/** A session is the person's whose agent key it first reported with, and a write naming it with another's is refused
 * (ORR-705). `session` is the id a request names, by `Orrery-Session` or in a hook's report. */
export async function holdSession(event: H3Event, session: string | undefined) {
    const who = event.context.who as Who | undefined
    if (who?.via !== 'agent' || !session) return
    const holder = await useStore().fixSessionPerson(session, who.person)
    if (holder !== who.person) throw conflict(`This session is ${holder}'s, and this is ${who.person}'s agent key, so it can't write as that session`)
}

/** `off`, as orrery has always been; `on`, asking for a credential; `closed` when told off on a server others can reach,
 * which refuses rather than opens. A database that can't say counts as on. */
export async function authMode(event: H3Event): Promise<'off' | 'on' | 'closed'> {
    const loopback = onLoopback(event)
    if (toldOff()) return loopback ? 'off' : 'closed'
    const on = String(useRuntimeConfig().auth || process.env.ORRERY_AUTH || '').toLowerCase() === 'on'
    if (on || !loopback || proxied(event)) return 'on'
    return await useStore().authStaysOn().catch(() => true) ? 'on' : 'off'
}

/** Whether this request may read what's on this orrery, for a route outside /api that the middleware leaves open (ORR-689):
 * anyone with auth off, and with it on, a credential. */
export async function mayRead(event: H3Event): Promise<boolean> {
    const mode = await authMode(event)
    return mode === 'off' || (mode === 'on' && !!await credential(event))
}

/** Whether anyone can get in: a provider is set up, or the owner has a person key. */
export async function canGetIn(): Promise<boolean> {
    return oidcOn() || await useStore().ownerHasKey()
}

const bearer = (event: H3Event) => /^Bearer\s+(\S+)$/i.exec(getHeader(event, 'authorization') ?? '')?.[1]

/** Who the request's credential says it is. A bearer is an agent key only: a person key is swapped for a cookie at
 * login and is no use here, so nothing with a key in its environment can act as a person. */
export async function credential(event: H3Event): Promise<Who | undefined> {
    const key = bearer(event)
    if (key) {
        const holder = await useStore().keyHolder(key)
        return holder?.kind === 'agent' ? {person: holder.person, owner: holder.owner, via: 'agent'} : undefined
    }
    const login = getCookie(event, LOGIN_COOKIE)
    const holder = login ? await useStore().loginHolder(login) : undefined
    return holder && {person: holder.person, owner: holder.owner, via: 'browser'}
}

/** The login's cookie: http-only so tokens stay out of the page's scripts, `Secure` whenever the request came over https. */
export async function logIn(event: H3Event, person: string) {
    const {secret, days} = await useStore().startLogin(person)
    setCookie(event, LOGIN_COOKIE, secret, {httpOnly: true, sameSite: 'lax', path: '/', maxAge: days * 86_400, secure: overHttps(event)})
}

export const overHttps = (event: H3Event) => getRequestProtocol(event, {xForwardedProto: true}) === 'https'
