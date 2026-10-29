// `POST /api/projects/:project/sessions/:session/stop` → the session: the owner stopping it. One orrery started
// goes through its launcher; any other through its channel, which ends its claude process. 409 when it has
// no channel running, so only its terminal can close it.
export default defineEventHandler(async event => {
    await authorize(event, 'sessions.start')
    return stopSession(param(event, 'project'), param(event, 'session'))
})
