// `PUT /api/projects/:project/issues/:issue/pulls/:owner/:name/:number/risk` {level, why} → {risk}: how risky the
// issue's PR `number` on GitHub repo `owner/name` is (ORR-879), high, medium or low, with a line on what decided it.
// The session that opens the PR rates it, and again when the PR changes; `{level: null}` takes the rating away. The
// owner's rating stands: a session's doesn't replace it (409). 404 when orrery keeps no such PR on the issue.
export default defineEventHandler(async event => usePulls().rateAsAsked(param(event, 'project'), param(event, 'issue'), `${param(event, 'owner')}/${param(event, 'name')}`,
    param(event, 'number'), await readBody(event), kindOf(event, await actorOf(event)) === 'owner'))
