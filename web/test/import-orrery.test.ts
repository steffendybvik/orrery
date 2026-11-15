import {describe, expect, it} from 'vitest'
import {freeId, freeKey, importOrrery, laterLinks, parseArgs, planProjects, planStatuses, prepareFile, rewriteLinks, summary} from '../scripts/import-orrery.mjs'

// `pnpm orrery:import` (ORR-1110): a whole orrery brought in as a new workspace of another. Its planning is pure, so it's
// tested here; the upload it ends in is the Rust API's, tested in board_upload_tests.rs.

describe('free ids and keys', () => {
    it('keeps one that is free, else numbers it within the limits', () => {
        expect(freeId('hub', new Set())).toBe('hub')
        expect(freeId('hub', new Set(['hub', 'hub-2']))).toBe('hub-3')
        const long = 'a'.repeat(40)
        expect(freeId(long, new Set([long]))).toHaveLength(40)
        expect(freeKey('HUB', new Set(['HUB']))).toBe('HUB2')
        expect(freeKey('ABCDEFGHIJ', new Set(['ABCDEFGHIJ']))).toBe('ABCDEFGHI2')
    })
})

describe('planProjects', () => {
    it('renames a clash, puts a release source first, and leaves one already there alone', () => {
        const source = [
            {id: 'app', key: 'APP', name: 'App', releases_from: 'core'},
            {id: 'core', key: 'ORR', name: 'Core'},
            {id: 'docs', key: 'DOC', name: 'Docs'},
        ]
        const target = [{id: 'orrery', key: 'ORR', name: 'orrery'}, {id: 'docs', key: 'DOC', name: 'Docs'}]
        const plan = planProjects(source, target, [{id: 'docs', key: 'DOC', name: 'Docs'}])
        expect(plan.map(p => p.from)).toEqual(['core', 'app', 'docs'])
        expect(plan[0]).toMatchObject({id: 'core', key: 'ORR2', renamed: true})
        expect(plan[1]).toMatchObject({id: 'app', key: 'APP', renamed: false})
        expect(plan[2]).toMatchObject({id: 'docs', skipped: true})
    })
})

describe('links', () => {
    it('rewrites a renamed project\'s page links and nothing that only starts like it', () => {
        const renames = new Map([['hub', 'hub-2']])
        expect(rewriteLinks('See [x](/p/hub/issues/HUB-1) and /p/hubble/docs', renames)).toBe('See [x](/p/hub-2/issues/HUB-1) and /p/hubble/docs')
        expect(rewriteLinks('/p/hub', renames)).toBe('/p/hub-2')
    })

    it('prepares a file without touching the one given, and describes every status', () => {
        const file = {
            project: 'app',
            statuses: [{id: 'todo', name: 'Todo', kind: 'todo'}],
            tables: {
                projects: [{id: 'app', releases_from: 'hub'}],
                issue_links: [{issue: 'APP-1', on_project: 'hub', on_issue: 'HUB-1'}, {issue: 'APP-1', on_project: 'app', on_issue: 'APP-2'}],
                comments: [{body: 'On /p/hub/issues/HUB-1'}],
            },
        }
        const out = prepareFile(file, new Map([['hub', 'hub-2']]), [{id: 'doing', name: 'Doing', kind: 'started'}])
        expect(out.tables.projects[0].releases_from).toBe('hub-2')
        expect(out.tables.issue_links.map((l: {on_project: string}) => l.on_project)).toEqual(['hub-2', 'app'])
        expect(out.tables.comments[0].body).toBe('On /p/hub-2/issues/HUB-1')
        expect(out.statuses.map((s: {id: string}) => s.id)).toEqual(['todo', 'doing'])
        expect(file.tables.comments[0].body).toBe('On /p/hub/issues/HUB-1')
    })

    it('puts back the links to a board brought in after its own', () => {
        const files = new Map([
            ['a', {tables: {issue_links: [{issue: 'A-1', on_project: 'b', on_issue: 'B-1'}, {issue: 'A-1', on_project: 'a', on_issue: 'A-2'}]}}],
            ['b', {tables: {issue_links: [{issue: 'B-1', on_project: 'a', on_issue: 'A-1'}]}}],
        ])
        const plan = [{from: 'a', id: 'a'}, {from: 'b', id: 'b-2'}]
        expect(laterLinks(files, plan)).toEqual([{project: 'a', issue: 'A-1', depends_on: ['b-2/B-1', 'A-2']}])
    })
})

describe('planStatuses', () => {
    it('matches by name and kind, makes the rest with a free id, and drops the workspace\'s own the source lacks', () => {
        const source = [{id: 'todo', name: 'Todo', kind: 'todo'}, {id: 'qa', name: 'QA', kind: 'started'}]
        const target = [{id: 'work-todo', name: 'todo', kind: 'todo'}, {id: 'work-doing', name: 'Doing', kind: 'started'}]
        const plan = planStatuses(source, target, ['work-todo', 'work-doing', 'work-qa'], 'work')
        expect(plan.map.get('todo')).toBe('work-todo')
        expect(plan.make).toEqual([{id: 'work-qa-2', name: 'QA', kind: 'started'}])
        expect(plan.drop).toEqual([{id: 'work-doing', name: 'Doing', into: 'work-qa-2'}])
    })
})

describe('parseArgs', () => {
    it('reads values and flags', () => {
        expect(parseArgs(['--from', 'http://a', '--dry-run', '--name', 'Work'])).toEqual({'from': 'http://a', 'dry-run': true, 'name': 'Work'})
    })
})

/** A fake orrery: GETs answered from `routes`, every write recorded. */
function fake(url: string, routes: Record<string, unknown>) {
    const writes: string[] = []
    const answer = async (path: string) => {
        if (!(path in routes)) throw Object.assign(new Error(`GET ${path}: 404`), {status: 404})
        return structuredClone(routes[path])
    }
    const write = (method: string) => async (path: string) => {
        writes.push(`${method} ${path}`)
        return {}
    }
    return {url, writes, get: answer, post: write('POST'), patch: write('PATCH'), del: write('DELETE'), upload: write('UPLOAD')}
}

describe('importOrrery', () => {
    const source = () => fake('http://work', {
        '/projects': [{id: 'hub', key: 'HUB', name: 'Hub'}, {id: 'orrery', key: 'ORR', name: 'orrery'}],
        '/settings': {tint: 'teal', statuses: [{id: 'todo', name: 'Todo', kind: 'todo'}]},
        '/projects/hub/export': {project: 'hub', tables: {issues: [{id: 'HUB-1'}], schedules: [{id: 1, title: 'Groom', enabled: 1}]}, people: [{id: 'ada', name: 'Ada'}]},
        '/projects/orrery/export': {project: 'orrery', tables: {issues: []}},
        '/secrets': [{name: 'STRIPE', hosts: ['api.stripe.com'], projects: ['orrery']}],
    })
    const target = (workspaces: unknown[] = []) => fake('http://home', {
        '/workspaces': workspaces,
        '/projects': [{id: 'orrery', key: 'ORR', name: 'orrery'}],
        '/people': [{id: 'steffen', name: 'steffen'}],
    })

    it('plans on a dry run and writes nothing to either', async () => {
        const from = source()
        const to = target()
        const report = await importOrrery({source: from, target: to, name: 'Work', dryRun: true})
        expect(from.writes).toEqual([])
        expect(to.writes).toEqual([])
        expect(report.projects.map((p: {id: string}) => p.id)).toEqual(['hub', 'orrery-2'])
        expect(report.secrets).toEqual([{name: 'STRIPE', hosts: ['api.stripe.com'], projects: ['orrery-2']}])
        expect(report.people).toEqual(['Ada'])
        expect(report.schedules.wasOn).toEqual(['hub: Groom'])
        const text = summary(report)
        expect(text).toContain('Dry run: nothing was written to http://home.')
        expect(text).toContain('orrery → orrery-2 (key ORR → ORR2)')
    })

    it('refuses a name the target already has unless told to add to it', async () => {
        await expect(importOrrery({source: source(), target: target([{id: 'work', name: 'Work'}]), name: 'work', dryRun: true})).rejects.toThrow(/--add/)
        await expect(importOrrery({source: source(), target: target(), name: 'Work', add: true, dryRun: true})).rejects.toThrow(/no workspace/)
        // An orrery from before workspaces answers the page's HTML.
        const old = fake('http://old', {'/workspaces': '<!DOCTYPE html>'})
        await expect(importOrrery({source: source(), target: old, name: 'Work', dryRun: true})).rejects.toThrow(/http:\/\/old has no workspaces/)
    })
})
