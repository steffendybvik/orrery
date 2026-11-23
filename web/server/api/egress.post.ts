// `POST /api/egress` {url, method?, headers?, body?, project?, issue?} → {status, headers, body, truncated?,
// secrets}: orrery makes the request with each `{{secret:NAME}}` filled in, to a host the secrets allow,
// and answers with their values scrubbed out. The project named is where its secrets are looked up, so it has to be
// one the asker sees: another person's is a 404, as one that isn't there, and their secrets go nowhere (ORR-1352).
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const project = (body as {project?: unknown} | null)?.project
    if (typeof project === 'string' && project) await needsSeen(event, project)
    return useSecrets().egress(body, await actorOf(event))
})
