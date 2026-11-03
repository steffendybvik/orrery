// Every branch on the projects' GitHub repos, with its issue and pull request and what to do with it (ORR-793). Read when
// the owner opens the view, not by the poll: branches change nothing else orrery does. With a token, one GraphQL query a
// hundred branches, which has each one's last commit, its PR and how far it's ahead. Without, GitHub's list has only
// names, so the PR comes from what orrery keeps (`issue_pulls`), and age and commits aren't known.
//
// A name can be written by anyone who can push, and a fork's PR isn't here at all, so `all` is the owner's alone
// (`pulls.branches`), but an issue's own branches go to sessions with their names held to `SAFE_BRANCH`, so one can carry on
// from another's (ORR-799, the owner's say over ORR-532, which still holds for a PR's title and head branch).
import type {AllBranches, IssueBranches, RepoBranch} from '#shared/roadmap'
import {branchVerdict, SAFE_BRANCH} from '#shared/roadmap'
import {conflict, notFound} from './input'
import {GITHUB_SECRET, issueIdsIn, PAGE, PAGES} from './pulls'
import type {Pulls} from './pulls'
import type {Store} from './store'

const FRESH = 60_000
const FRESH_WITHOUT_TOKEN = 5 * 60_000

const FIELDS = `name target { ... on Commit { oid committedDate } }
    associatedPullRequests(first: 1, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number url state headRefOid } }
    compare(headRef: $base) { behindBy }`
const QUERY = `query($owner: String!, $name: String!, $base: String!, $after: String) {
    repository(owner: $owner, name: $name) {
        defaultBranchRef { name }
        refs(refPrefix: "refs/heads/", first: ${PAGE}, after: $after) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }
    }
}`
const DEFAULT = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { defaultBranchRef { name } } }`

interface GraphBranch {
    name: string
    target: {oid?: string, committedDate?: string} | null
    associatedPullRequests: {nodes: {number: number, url: string, state: string, headRefOid: string | null}[]}
    /** From the branch to `base`: what it's behind by is what it has that `base` hasn't. */
    compare: {behindBy: number} | null
}

interface GraphAnswer {
    data?: {repository: {defaultBranchRef: {name: string} | null, refs?: {nodes: GraphBranch[], pageInfo: {hasNextPage: boolean, endCursor: string | null}}} | null}
    errors?: {message: string, type?: string}[]
}

type Read = Omit<RepoBranch, 'issue' | 'verdict' | 'why' | 'repo' | 'carry_on'> & {head_sha?: string | null}
type RepoRead = AllBranches['repos'][number] & {branches: RepoBranch[]}

export class Branches {
    private readonly reads = new Map<string, {at: number, read: RepoRead}>()

    constructor(
        private readonly store: Store,
        private readonly pulls: Pulls,
        private readonly hasToken: (project: string) => Promise<boolean>,
        private readonly now: () => number = Date.now,
    ) {}

    /** Every repo's branches: those to look at first, then to remove, then to keep, the newest first in each. */
    async all(): Promise<AllBranches> {
        const reads: RepoRead[] = []
        for (const [repo, projects] of await this.pulls.repos()) reads.push(await this.read(repo, projects))
        const order = {look: 0, remove: 1, keep: 2}
        const branches = reads.flatMap(r => r.branches).sort((a, b) => order[a.verdict] - order[b.verdict]
            || (b.committed_at ?? '').localeCompare(a.committed_at ?? '') || a.name.localeCompare(b.name))
        return {branches, repos: reads.map(({branches: _branches, ...repo}) => repo)}
    }

    /** The branches the issue's work can carry on from, the newest first; `session` is who's asking, so it isn't told of itself. */
    async forIssue(project: string, id: string, session: string | undefined): Promise<IssueBranches> {
        project = await this.store.projectId(project)
        const issue = await this.pulls.issueOf([project], [id])
        if (!issue) throw notFound(`No issue ${id} in ${project}`)
        const entry = [...await this.pulls.repos()].find(([, projects]) => projects.includes(project))
        if (!entry) return {repo: null, base: null, branches: []}
        const read = await this.read(...entry)
        const other_session = !!await this.store.takenFrom(project, issue.id, session).catch(() => null)
        const branches = read.branches
            .filter(b => b.carry_on && b.issue?.project === project && b.issue.id === issue.id && SAFE_BRANCH.test(b.name))
            .sort((a, b) => (b.committed_at ?? '').localeCompare(a.committed_at ?? '') || a.name.localeCompare(b.name))
            .map(({name, sha, committed_at, ahead, pull}) => ({name, sha, committed_at, ahead, ...pull ? {pull} : {}, other_session}))
        return {repo: read.repo, base: read.base, branches, ...read.error ? {error: read.error} : {}}
    }

    /** The owner removing a branch: only one that still reads as remove, asked afresh, so nothing that has moved on since the
     * page was read goes. */
    async remove(repo: string, name: string) {
        const projects = (await this.pulls.repos()).get(repo)
        if (!projects) throw notFound(`No project's repo is ${repo} on GitHub`)
        this.reads.delete(repo)
        const read = await this.read(repo, projects)
        if (read.error) throw conflict(read.error)
        const branch = read.branches.find(b => b.name === name)
        if (!branch) throw notFound(`${repo} has no branch ${name}`)
        if (branch.verdict !== 'remove') throw conflict(`${name} no longer reads as one to remove: ${branch.why}`)
        await this.pulls.deleteBranch(repo, projects[0] ?? '', name)
        this.reads.delete(repo)
    }

    private async read(repo: string, projects: string[]): Promise<RepoRead> {
        const kept = this.reads.get(repo)
        const now = this.now()
        const [asker = ''] = projects
        const token = await this.hasToken(asker)
        if (kept && kept.read.token === token && now - kept.at < (token ? FRESH : FRESH_WITHOUT_TOKEN)) return kept.read
        const read = await this.fresh(repo, projects, asker, token)
            .catch((error: Error): RepoRead => ({repo, projects, base: null, token, error: error.message, branches: kept?.read.branches ?? []}))
        this.reads.set(repo, {at: now, read})
        return read
    }

    private async fresh(repo: string, projects: string[], asker: string, token: boolean): Promise<RepoRead> {
        const among = projects.map(() => '?').join(', ')
        // The branches of releases being prepared: the base is the newest.
        const preparing = (await this.store.db.all<{branch: string}>(`SELECT branch FROM releases WHERE project IN (${among}) AND branch IS NOT NULL AND shipped_on IS NULL ORDER BY created_at DESC`, ...projects)).map(r => r.branch)
        const {read, base, more, main} = token ? await this.graph(repo, asker, preparing[0]) : await this.list(repo, asker)
        const held = new Set([...preparing, ...main ? [main] : []])
        const branches: RepoBranch[] = []
        for (const branch of read) {
            const issue = await this.pulls.issueOf(projects, issueIdsIn({body: '', head: {ref: branch.name}}))
            const kind = issue ? await this.kindOf(issue.project, issue.id) : undefined
            const worked = !!issue && kind === 'started' && !!await this.store.takenFrom(issue.project, issue.id, undefined).catch(() => null)
            const {head_sha, ...shown} = branch
            const facts = {
                held: held.has(branch.name), sha: branch.sha, ahead: branch.ahead, ...kind ? {issueKind: kind} : {},
                ...branch.pull ? {pull: {state: branch.pull.state, head_sha}} : {},
            }
            // Without the session: one on the issue keeps a spent branch from removal, which doesn't make it work to pick up.
            const carry_on = !facts.held && branch.pull?.state !== 'closed' && branchVerdict({...facts, worked: false}).verdict !== 'remove'
            branches.push({...shown, repo, ...issue ? {issue: {...issue, kind: kind ?? ''}} : {}, carry_on, ...branchVerdict({...facts, worked})})
        }
        return {repo, projects, base, token, branches, ...more ? {cut: read.length} : {}}
    }

    /** The kind of status the issue is in: started, done… */
    private async kindOf(project: string, id: string) {
        const row = await this.store.db.get<{status: string}>('SELECT status FROM issues WHERE project = ? AND id = ?', project, id)
        return (await this.store.statuses()).find(s => s.id === row?.status)?.kind
    }

    private async graph(repo: string, asker: string, preparing: string | undefined) {
        const [owner, name] = repo.split('/')
        const ask = async (query: string, variables: Record<string, unknown>) => {
            const {value} = await this.pulls.ask<GraphAnswer>(repo, asker, '/graphql', {query, variables: {owner, name, ...variables}})
            if (value.errors?.length) {
                throw new Error(value.errors.some(e => e.type === 'FORBIDDEN')
                    ? `The ${GITHUB_SECRET} secret can't read ${repo}'s branches: give it Contents: Read-only`
                    : `GitHub answered for ${repo}: ${value.errors.map(e => e.message).join('; ')}`)
            }
            if (!value.data?.repository) throw new Error(`GitHub has no ${repo} that the ${GITHUB_SECRET} secret can read`)
            return value.data.repository
        }
        const base = preparing ?? (await ask(DEFAULT, {})).defaultBranchRef?.name ?? 'main'
        const read: Read[] = []
        let main: string | undefined
        let after: string | null = null
        let more = false
        for (let page = 0; page < PAGES; page++) {
            const found: Awaited<ReturnType<typeof ask>> = await ask(QUERY, {base, after})
            main = found.defaultBranchRef?.name ?? main
            for (const node of found.refs?.nodes ?? []) {
                const pull = node.associatedPullRequests.nodes[0]
                read.push({
                    name: node.name, sha: node.target?.oid ?? '', committed_at: node.target?.committedDate ?? null, ahead: node.compare?.behindBy ?? null,
                    ...pull ? {pull: {number: pull.number, url: pull.url, state: pull.state.toLowerCase() as 'open' | 'merged' | 'closed'}, head_sha: pull.headRefOid} : {},
                })
            }
            more = !!found.refs?.pageInfo.hasNextPage
            after = found.refs?.pageInfo.endCursor ?? null
            if (!more || !after) break
        }
        return {read, base, more, main}
    }

    /** Without a token GitHub's list says only a name and a commit, so the PR is the latest orrery keeps of that branch. */
    private async list(repo: string, asker: string) {
        const {value, more} = await this.pulls.askPages<{name: string, commit: {sha: string}}>(repo, asker, `/repos/${repo}/branches?per_page=${PAGE}`)
        const kept = await this.store.db.all<{branch: string, number: number, url: string, state: 'open' | 'merged' | 'closed'}>(
            'SELECT DISTINCT branch, number, url, state FROM issue_pulls WHERE repo = ? ORDER BY number', repo)
        const read: Read[] = value.map(({name, commit}) => {
            const pull = kept.findLast(k => k.branch === name)
            return {name, sha: commit.sha, committed_at: null, ahead: null, ...pull ? {pull: {number: pull.number, url: pull.url, state: pull.state}} : {}}
        })
        return {read, base: null, more, main: undefined}
    }
}
