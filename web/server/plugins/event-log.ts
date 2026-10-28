import type {LaunchEvent} from '../utils/launches'

// Fills the event log (server/utils/event-log.ts): every 5xx the server answers with, each 403 and 409 as a refusal, its starts and the migrations
// they ran, and the sessions Orrery starts and stops. Old events are pruned on start and every hour.
export default defineNitroPlugin(nitro => {
    const log = useEventLog()
    const {version} = useRuntimeConfig().public
    nitro.hooks.hook('error', (error, {event}) => {
        const status = (error as {statusCode?: number}).statusCode ?? 500
        if (status < 500) {
            const refused = event && refusal(status, event.method, event.path, error.message, getHeader(event, 'orrery-actor')?.trim().slice(0, 60))
            if (refused) log.note(refused)
            return
        }
        log.note({level: 'error', kind: 'server.error', message: error.message, details: {
            // The path alone: a query can hold what isn't the log's to keep.
            ...event ? {route: `${event.method} ${event.path.split('?')[0]}`} : {}, status, stack: error.stack, version,
        }})
    })
    log.prune().then(() => {
        const ran = takeMigration()
        if (ran) log.note({level: 'info', kind: 'migration.ran', message: ran.from ? `Brought the database from step ${ran.from} to ${ran.to}` : `Laid down a new database (step ${ran.to})`, details: {...ran, database: describeDatabase().kind}})
        log.note({level: 'info', kind: 'server.started', message: `Orrery ${version} started`, details: {version, database: describeDatabase().kind}})
    }, error => console.error('[orrery] opening the event log:', error))
    const timer = setInterval(() => log.prune().catch(error => console.error('[orrery] pruning the event log:', error)), 60 * 60 * 1000)
    nitro.hooks.hook('close', () => clearInterval(timer))

    projectEvents.on('launches', (sent: LaunchEvent) => {
        // The owner's chat isn't one of the sessions Orrery starts: it's logged as neither, so nothing runs on it.
        if (sent.type === 'launch' ? sent.launch.chat : sent.type === 'stop' && sent.chat) return
        if (sent.type === 'launch') {
            const {id, project, minutes, hears} = sent.launch
            log.note({level: 'info', kind: 'session.started', project, message: `Started a session${minutes ? ` for ${minutes} minutes` : ''}`, details: {launch: id, ...hears ? {hears} : {}}})
        } else if (sent.type === 'stop') {
            log.note({level: 'info', kind: 'session.stopping', project: sent.project, message: 'Asked a session Orrery started to stop', details: {launch: sent.id}})
        }
    })
})
