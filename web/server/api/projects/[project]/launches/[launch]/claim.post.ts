// `POST /api/projects/:project/launches/:launch/claim` → {claimed}: a launcher taking the launch on. Only the
// first launcher gets `true`, so a project with several launchers starts one session for it. `?untrusted=no-bash` says
// the launcher starts an untrusted launch locked down, with no Bash (an older one says `yes`, and gave it `gh`), and `?chat=yes` that it starts a chat able only to read and
// answer; only such a launcher gets one.
export default defineEventHandler(event => {
    const query = getQuery(event)
    return {claimed: claim(param(event, 'project'), param(event, 'launch'), query.untrusted === 'no-bash', query.chat === 'yes')}
})
