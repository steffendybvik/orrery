// `GET /api/events/log?level=&kind=&project=&subject=&since=&open=1&limit=` → the event log, newest first: `level` one
// or more of error, warn, info (comma-separated); `kind` one (`server.error`) or every one under a name (`session`,
// `issue`); `subject` what a change to the roadmap was to (`ORR-12`); `open=1` only those not resolved. Up to `limit`
// (200 by default, 1000 at most).
export default defineEventHandler(async event => {
    const {level, kind, project, subject, since, open, limit} = getQuery(event)
    return useEventLog().list({
        level: level ? String(level) : undefined,
        kind: kind ? String(kind) : undefined,
        project: project ? String(project) : undefined,
        subject: subject ? String(subject) : undefined,
        since: since ? String(since) : undefined,
        open: open === '1' || open === 'true',
        limit: limit === undefined ? undefined : Number(limit) || undefined,
    })
})
