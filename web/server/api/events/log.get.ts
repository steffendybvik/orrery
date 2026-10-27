// `GET /api/events/log?level=&kind=&project=&since=&open=1&limit=` → the event log, newest first (by when each was
// last seen): `level` one or more of error, warn, info (comma-separated); `kind` one (`server.error`) or every one
// under a name (`session`); `open=1` only those not resolved. Up to `limit` (200 by default, 1000 at most).
export default defineEventHandler(async event => {
    const {level, kind, project, since, open, limit} = getQuery(event)
    return useEventLog().list({
        level: level ? String(level) : undefined,
        kind: kind ? String(kind) : undefined,
        project: project ? String(project) : undefined,
        since: since ? String(since) : undefined,
        open: open === '1' || open === 'true',
        limit: limit === undefined ? undefined : Number(limit) || undefined,
    })
})
