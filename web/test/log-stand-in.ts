// A stand-in for the Rust API's event log routes (ORR-1088), for a unit test of what the event log makes and says
// (utils/event-log.ts) rather than of what the API does with a line, which cargo tests (routes/event_log_tests.rs): it
// keeps each line, says a repeat of an open one is no news, reads Advanced from `advanced`, and answers 503 while `down`.
import type {LoggedEvent} from '#shared/roadmap'
import {EventLog} from '../server/utils/event-log'

export interface StandIn {
    advanced: boolean | (() => Promise<boolean>)
    down: boolean
    refusing: Error | undefined
    sent: {method: string, path: string, body?: unknown}[]
    lines: (LoggedEvent & {activity?: true})[]
    send: (method: string, path: string, body?: unknown) => Promise<unknown>
}

export function standInApi(advanced: StandIn['advanced'] = true): StandIn {
    const api: StandIn = {
        advanced,
        down: false,
        refusing: undefined,
        sent: [],
        lines: [],
        send: async (method, path, body) => {
            if (api.down) throw Object.assign(new Error("The Rust API can't be reached"), {statusCode: 503})
            if (api.refusing) throw api.refusing
            api.sent.push({method, path, body})
            if (path === '/api/settings') return {advanced: typeof api.advanced === 'function' ? await api.advanced() : api.advanced}
            if (path === '/api/events/log/prune') return {pruned: 3}
            const line = body as {level: LoggedEvent['level'], kind: string, project?: string, message: string, activity?: true}
            const again = !line.activity && api.lines.some(l => l.level === line.level && l.kind === line.kind && (l.project ?? '') === (line.project ?? '') && l.message === line.message)
            const event = {id: api.lines.length + 1, project: null, subject: null, details: null, resolved_at: null, resolved_by: null, ...line, count: 1, first_seen: 'x', last_seen: 'x'} as LoggedEvent
            api.lines.push(event)
            return {event, fresh: !again}
        },
    }
    return api
}

/** An event log sending to a stand-in API whose Advanced is the store's setting, as the API's would be. */
export function standInLog(store: {settings(): Promise<{advanced?: boolean}>}): EventLog {
    return new EventLog(undefined, undefined, standInApi(async () => (await store.settings()).advanced !== false).send)
}
