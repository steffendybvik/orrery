// `POST /api/projects/:project/launches/:launch/claim` → {claimed}: a launcher taking the launch on. Only the
// first launcher gets `true`, so a project with several launchers starts one session for it. Its `Orrery-Launcher`
// header is the token its stream gave it (`ready`): a claim without a connected launcher's is refused (ORR-443). `?untrusted=no-bash` says
// the launcher starts an untrusted launch locked down, with no Bash (an older one says `yes`, and gave it `gh`), and `?chat=yes` that it starts a chat able only to read and
// answer, `?model=yes` that it starts a session on the model and effort a launch asks for, and `?resume=yes` that it takes a
// chat's Claude session up again (`claude --resume`, ORR-884); only such a launcher gets one, and an older one starts
// a resumed chat fresh, told what was said.
export default defineEventHandler(event => {
    const query = getQuery(event)
    return {claimed: claim(param(event, 'project'), param(event, 'launch'), getHeader(event, 'orrery-launcher'), query.untrusted === 'no-bash', query.chat === 'yes', query.model === 'yes', query.resume === 'yes')}
})
