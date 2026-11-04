// `PUT /api/projects/:project/issues/:issue/pulls/:owner/:name/:number/risk` {level, why} → {risk}: how risky the
// issue's PR `number` on GitHub repo `owner/name` is (ORR-879), high, medium or low, with a line on what decided it.
// The session that opens the PR rates it, and again when the PR changes; `{level: null}` takes the rating away. The
// owner's rating stands: a session's doesn't replace it (409). 404 when orrery keeps no such PR on the issue.
import {RISK_LEVELS} from '#shared/roadmap'
import type {RiskLevel} from '#shared/roadmap'

export default defineEventHandler(async event => {
    const number = Number(param(event, 'number').replace(/^#/, ''))
    if (!Number.isInteger(number) || number < 1) throw badRequest('Give the pull request by its number, e.g. 788')
    const input = checkInput(await readBody(event), {
        level: {type: 'string', required: true, nullable: true, values: RISK_LEVELS},
        why: {type: 'string'},
    })
    const why = typeof input.why === 'string' ? input.why.trim().slice(0, 300) : ''
    if (input.level !== null && !why) throw badRequest('Say why in a line, e.g. "high: bug fix in signal routing"')
    const owner = kindOf(event, await actorOf(event)) === 'owner'
    const risk = await usePulls().rate(param(event, 'project'), param(event, 'issue'), `${param(event, 'owner')}/${param(event, 'name')}`, number,
        input.level === null ? null : {level: input.level as RiskLevel, why}, owner)
    return {risk}
})
