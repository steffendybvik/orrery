// `POST /api/projects/:project/launches/:launch/claim` → {claimed}: a launcher taking the launch on. Only the
// first launcher gets `true`, so a project with several launchers starts one session for it. `?untrusted=yes` says
// the launcher starts an untrusted launch locked down, and `?chat=yes` that it starts a chat able only to read and
// answer; only such a launcher gets one.
export default defineEventHandler(event => {
    const query = getQuery(event)
    return {claimed: claim(param(event, 'project'), param(event, 'launch'), query.untrusted === 'yes', query.chat === 'yes')}
})
