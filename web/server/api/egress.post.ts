// `POST /api/egress` {url, method?, headers?, body?, project?, issue?} → {status, headers, body, truncated?,
// secrets}: orrery makes the request with each `{{secret:NAME}}` filled in, to a host the secrets allow,
// and answers with their values scrubbed out. The project is one the caller sees (ORR-1352, ORR-1359), and for a
// session one in the workspace it works in, so the secrets are their own: any other is the same 404 as one that isn't
// here, before a secret is read.
export default defineEventHandler(async event => {
    const body = await readBody(event)
    const named = (body as {project?: unknown} | null)?.project
    const project = named === undefined || named === null || named === '' ? undefined : await seenProjectOf(event, String(named))
    return useSecrets().egress(project === undefined ? body : {...body as object, project}, await actorOf(event))
})
