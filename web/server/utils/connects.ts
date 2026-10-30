// Connect a repo with a click (ORR-708): the owner asks, a launcher that can open a folder picker takes it on, the owner
// chooses a folder on that machine and ticks the projects it holds on the page, and the launcher writes the files. Kept in
// this process's memory, as launches are: it's a few minutes' conversation with a person watching. orrery never hears a
// path and never names one: the launcher keeps the folder, and says only its last part, to show.
import {randomBytes} from 'node:crypto'
import type {TerminalApp} from '#shared/roadmap'
import type {ConnectRequest, ConnectState} from '#shared/connects'

export type ConnectEvent =
    | {type: 'pick', id: string}
    | {type: 'write', id: string, token: string, projects: {id: string, key: string}[], orrery: {id: string, environment: string}, terminal: TerminalApp}

interface Held extends ConnectRequest { token?: string, at: number }

const KEEP_FOR = 15 * 60_000
const requests = new Map<string, Held>()
/** The connected launchers that can open a picker, by their stream's token: their machine's name, if they say. */
const pickers = new Map<string, string>()
const OPEN: ConnectState[] = ['asking', 'picking', 'picked', 'writing']

const shown = ({token: _, at: __, ...request}: Held): ConnectRequest => request
function forgetOld(now = Date.now()) {
    for (const [id, request] of requests) if (now - request.at > KEEP_FOR) requests.delete(id)
}

/** A launcher's stream opening: its token for what it reports, until `done`. Going, it fails what it had taken on, so
 * the page doesn't wait on a picker that's gone. */
export function addPicker(host: string): (() => void) & {token: string} {
    const token = randomBytes(18).toString('base64url')
    pickers.set(token, host)
    return Object.assign(() => {
        pickers.delete(token)
        for (const request of requests.values()) {
            if (request.token === token && OPEN.includes(request.state)) Object.assign(request, {state: 'failed', message: 'The launcher went before it finished. Try again.'})
        }
    }, {token})
}

export const pickersConnected = () => pickers.size

/** The latest request still under way, so a page opened or reloaded carries on with it. */
export function currentConnect(): ConnectRequest | undefined {
    forgetOld()
    const open = [...requests.values()].filter(request => OPEN.includes(request.state)).sort((a, b) => b.at - a.at)
    return open[0] && shown(open[0])
}

/** The owner pressing Connect a repo. A launcher opens the picker on its machine, whichever takes it first. */
export function askConnect(): ConnectRequest {
    forgetOld()
    if (!pickers.size) throw conflict('No launcher that can open a folder picker is running: install one, or use the line on this page')
    const id = randomBytes(9).toString('base64url')
    const request: Held = {id, state: 'asking', at: Date.now()}
    requests.set(id, request)
    projectEvents.emit('connects', {type: 'pick', id} satisfies ConnectEvent)
    return shown(request)
}

function requestOf(id: string): Held {
    const request = requests.get(id)
    if (!request) throw notFound(`No connect request ${id}`)
    return request
}

export const connectOf = (id: string): ConnectRequest => shown(requestOf(id))

const REPORTS: Partial<Record<ConnectState, ConnectState[]>> = {
    picking: ['asking'],
    picked: ['picking'],
    canceled: ['picking'],
    failed: ['picking', 'writing'],
    done: ['writing'],
}

/** What a launcher says as it goes, by its stream's `token`. The first to say `picking` has it, and any other is told it
 * didn't, so one picker opens. Says whether this launcher holds it. */
export function reportConnect(id: string, token: string | undefined, report: Partial<ConnectRequest>): boolean {
    if (!token || !pickers.has(token)) throw forbidden('Only a connected launcher reports on a connect request')
    const request = requestOf(id)
    if (report.state === 'picking' && request.state === 'asking') {
        request.token = token
        request.host = pickers.get(token) || undefined
    }
    if (request.token !== token) return false
    if (!report.state || !REPORTS[report.state]?.includes(request.state)) return true
    Object.assign(request, report)
    return true
}

/** The owner's tick of the projects the chosen folder holds: the launcher it's with writes the files. It's that
 * launcher's folder alone: nothing here can say another. */
export function writeConnect(id: string, projects: {id: string, key: string}[], orrery: {id: string, environment: string}, terminal: TerminalApp): ConnectRequest {
    const request = requestOf(id)
    if (request.state !== 'picked' || !request.token) throw conflict('There\'s no chosen folder waiting on this request')
    if (!projects.length && !request.every && !request.projects?.length) throw badRequest('Tick at least one project')
    request.state = 'writing'
    projectEvents.emit('connects', {type: 'write', id, token: request.token, projects, orrery, terminal} satisfies ConnectEvent)
    return shown(request)
}
