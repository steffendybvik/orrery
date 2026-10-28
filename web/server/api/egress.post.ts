// `POST /api/egress` {url, method?, headers?, body?, project?, issue?} → {status, headers, body, truncated?,
// secrets}: orrery makes the request with each `{{secret:NAME}}` filled in, to a host the secrets allow,
// and answers with their values scrubbed out.
export default defineEventHandler(async event => useSecrets().egress(await readBody(event), await actorOf(event)))
