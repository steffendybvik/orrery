// `POST /api/projects/:project/launches/:launch/claim` → {claimed}: a launcher taking the launch on. Only the
// first launcher gets `true`, so a project with several launchers starts one session for it. `?untrusted=yes` says
// the launcher starts an untrusted launch locked down; only such a launcher gets one.
export default defineEventHandler(event => ({claimed: claim(param(event, 'project'), param(event, 'launch'), getQuery(event).untrusted === 'yes')}))
