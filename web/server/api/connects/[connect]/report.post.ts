import type {ConnectState} from '#shared/connects'

// `POST /api/connects/:connect/report {state, …}` → {claimed}: a launcher saying how a connect request is going, with the token
// its stream gave it (`Orrery-Launcher`). Only the first to say `picking` holds the request. What it says is only ever shown,
// and cut to size.
export default defineEventHandler(async event => {
    const {state, folder, projects, every, written, unchanged, opened, message} = checkInput(await readBody(event), {
        state: {type: 'string', required: true}, folder: {type: 'string'}, projects: {type: 'strings'}, every: {type: 'boolean'},
        written: {type: 'strings'}, unchanged: {type: 'strings'}, opened: {type: 'boolean'}, message: {type: 'string'},
    })
    const list = (value: unknown) => Array.isArray(value) ? value.slice(0, 200).map(item => String(item).slice(0, 100)) : undefined
    const text = (value: unknown, size: number) => typeof value === 'string' ? value.slice(0, size) : undefined
    const report = Object.fromEntries(Object.entries({
        state: state as ConnectState, folder: text(folder, 200), projects: list(projects), every: every as boolean | undefined,
        written: list(written), unchanged: list(unchanged), opened: opened as boolean | undefined, message: text(message, 400),
    }).filter(([, value]) => value !== undefined))
    return {claimed: reportConnect(param(event, 'connect'), getHeader(event, 'orrery-launcher'), report)}
})
