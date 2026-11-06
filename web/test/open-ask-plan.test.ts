import {describe, expect, it} from 'vitest'
import {openDb} from '../server/utils/db'
import {OPEN_ASK} from '../server/store/schema'

// A board's open questions are read by its project's index (ORR-934). On `owned` alone, SQLite read every agent's
// comment in the orrery once for each project: most of what GET /api/projects took on a big orrery. SQLite's plan only:
// Postgres plans from its own statistics.
const plan = (sql: string, ...params: string[]) => {
    const db = openDb(':memory:')
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {detail: string}[]).map(row => row.detail).join('\n')
}

describe.skipIf(!!process.env.TEST_POSTGRES_URL)("an issue's open questions", () => {
    it("are found through the project's comments, on a board", () => {
        const found = plan(`SELECT c.issue, c.asks FROM comments c WHERE c.project = ? AND ${OPEN_ASK} ORDER BY c.id`, 'p')
        expect(found).toMatch(/SEARCH c USING INDEX comments_issue \(project=\?\)/)
        expect(found).not.toContain('comments_notices')
    })

    it("and through the issue's, for one issue", () => {
        const found = plan(`SELECT c.created_by FROM comments c WHERE c.project = ? AND c.issue = ? AND ${OPEN_ASK}`, 'p', 'i')
        expect(found).toMatch(/SEARCH c USING INDEX comments_issue \(project=\? AND issue=\?\)/)
    })
})
