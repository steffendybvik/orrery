// The pull requests on the projects' GitHub repos, polled in the background (ORR-506): what each was is kept
// (pull_states), and a poll that finds one changed (conflicting, behind, failing its checks, changes requested, merged,
// closed, or back to ready or approved) says so once, as a `PullChange`, for what acts on it. The pages read what it
// keeps while it's fresh (pulls.ts).
//
// With a GITHUB_TOKEN secret each repo is one GraphQL query a minute: its open PRs, and those most recently merged or
// closed. Without one GitHub allows 60 requests an hour, so it's two REST lists every ten minutes, which say nothing of
// a PR's state but do say it merged or closed. A repo's first poll only records: turning it on tells nothing of the PRs
// already open. A rate limit holds the repo until GitHub's reset (shared with the pages); a refused token holds it an
// hour, said once in the event log until a poll works again.
import type {PullState} from '#shared/roadmap'
import {PULL_NEEDS} from '#shared/roadmap'
import type {EventEntry} from './event-log'
import type {KeptPull, ListedPull, Pulls} from './pulls'
import {GITHUB_SECRET, issueIdsIn, pullState} from './pulls'
import type {Store} from './store'

/** How often a repo is polled: with a token, and without one. */
export const POLL_EVERY = 60_000
export const POLL_WITHOUT_TOKEN = 10 * 60_000
/** How long a refused token holds a repo before it's tried again. */
const REFUSED_FOR = 60 * 60_000
/** The most recently merged or closed PRs each poll reads: enough for a busy minute, or ten minutes without a token. */
const DONE = 30
/** How long a merged or closed PR, or a repo nobody points at any more, is kept. */
const KEEP = 7 * 24 * 60 * 60_000

export type PullChangeKind = 'conflicting' | 'behind' | 'checks_failed' | 'changes_requested' | 'merged' | 'closed' | 'ready' | 'approved'

/** A PR that changed, on the issue it names: `key` is the same for the same change (the PR, the kind, and the head
 * commit or review it was on), so it goes out once. */
export interface PullChange {
    project: string
    issue: string
    repo: string
    kind: PullChangeKind
    key: string
    pull: {number: number, title: string, url: string, branch: string, base: string, head_sha: string | null, merge_sha: string | null, closed_by: string | null, review_id: string | null}
    /** For changes requested: who asked, what they wrote, and their comments on lines (ORR-508). */
    review?: {by: string, body: string, comments: {path: string, line: number | null, body: string}[]}
    /** For checks failed: how many times they have failed on this PR, this one counted. */
    failures?: number
}

/** A PR as a poll read it. */
interface Polled {
    number: number
    title: string
    url: string
    body: string
    branch: string
    base: string
    author: string
    draft: boolean
    head_sha: string | null
    /** null when this poll can't tell (no token). */
    state: PullState | null
    review: string | null
    review_id: string | null
    /** The latest review that asked for changes: by whom, its text and its comments on lines (with a token). */
    review_by?: string
    review_body?: string
    review_comments?: {path: string, line: number | null, body: string}[]
    checks: string | null
    merged: boolean
    closed: boolean
    merge_sha: string | null
    closed_by: string | null
    created_at: string
    updated_at: string
}

const FIELDS = `number title url body isDraft headRefName baseRefName headRefOid createdAt updatedAt
    author { login } mergeStateStatus reviewDecision merged closed mergeCommit { oid }
    reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { id author { login } body comments(first: 20) { nodes { path line body } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`
const QUERY = `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
        open: pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS} } }
        done: pullRequests(states: [MERGED, CLOSED], first: ${DONE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS}
            timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } } } }
    }
}`

interface GraphPull {
    number: number
    title: string
    url: string
    body: string | null
    isDraft: boolean
    headRefName: string
    baseRefName: string
    headRefOid: string | null
    createdAt: string
    updatedAt: string
    author: {login: string} | null
    mergeStateStatus: string | null
    reviewDecision: string | null
    merged: boolean
    closed: boolean
    mergeCommit: {oid: string} | null
    reviews?: {nodes: {id: string, author?: {login: string} | null, body?: string | null, comments?: {nodes: {path: string, line: number | null, body: string}[]}}[]}
    commits?: {nodes: {commit: {statusCheckRollup: {state: string} | null}}[]}
    timelineItems?: {nodes: {actor?: {login: string} | null}[]}
}

function fromGraph(pull: GraphPull): Polled {
    const checks = pull.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null
    return {
        number: pull.number, title: pull.title, url: pull.url, body: pull.body ?? '', branch: pull.headRefName, base: pull.baseRefName,
        author: pull.author?.login ?? '', draft: pull.isDraft, head_sha: pull.headRefOid,
        state: pullState(pull.isDraft, pull.mergeStateStatus?.toLowerCase()),
        review: pull.reviewDecision, review_id: pull.reviews?.nodes[0]?.id ?? null,
        review_by: pull.reviews?.nodes[0]?.author?.login ?? '', review_body: pull.reviews?.nodes[0]?.body ?? '', review_comments: pull.reviews?.nodes[0]?.comments?.nodes ?? [],
        // ERROR is a failure too; EXPECTED (a required check not reported yet) is waiting, as PENDING is.
        checks: checks === 'ERROR' ? 'failure' : checks === 'EXPECTED' ? 'pending' : checks?.toLowerCase() ?? null,
        merged: pull.merged, closed: pull.closed && !pull.merged, merge_sha: pull.mergeCommit?.oid ?? null,
        closed_by: pull.timelineItems?.nodes[0]?.actor?.login ?? null, created_at: pull.createdAt, updated_at: pull.updatedAt,
    }
}

function fromList(pull: ListedPull & {closed_at?: string | null}): Polled {
    const merged = !!pull.merged_at
    return {
        number: pull.number, title: pull.title, url: pull.html_url, body: pull.body ?? '', branch: pull.head.ref, base: pull.base.ref,
        author: pull.user?.login ?? '', draft: !!pull.draft, head_sha: pull.head.sha ?? null, state: pull.draft ? 'draft' : null,
        review: null, review_id: null, checks: null, merged, closed: !merged && !!pull.closed_at, merge_sha: merged ? pull.merge_commit_sha ?? null : null,
        closed_by: null, created_at: pull.created_at, updated_at: pull.updated_at,
    }
}

/** What changed from `was` (none: first seen) to `now`, in the order they're told. */
export function changesOf(was: Pick<KeptPull, 'state' | 'checks' | 'review' | 'merged' | 'closed'> | undefined, now: Polled): PullChangeKind[] {
    if (now.merged) return was && !was.merged ? ['merged'] : []
    if (now.closed) return was && !was.closed ? ['closed'] : []
    const kinds: PullChangeKind[] = []
    // A state the poll couldn't tell, or GitHub is still working out, is no news.
    if (now.state && now.state !== 'checking' && now.state !== was?.state) {
        if (now.state === 'conflicting' || now.state === 'behind') kinds.push(now.state)
        else if (now.state === 'ready' && was && PULL_NEEDS.includes(was.state)) kinds.push('ready')
    }
    if (now.checks === 'failure' && was?.checks !== 'failure') kinds.push('checks_failed')
    if (now.review === 'CHANGES_REQUESTED' && was?.review !== 'CHANGES_REQUESTED') kinds.push('changes_requested')
    if (now.review === 'APPROVED' && was && was.review !== 'APPROVED') kinds.push('approved')
    return kinds
}

/** The key that keeps a change to once: the PR, the kind, and what it's on. */
function keyOf(repo: string, pull: Polled, kind: PullChangeKind): string {
    const on = kind === 'changes_requested' ? pull.review_id ?? pull.head_sha : kind === 'merged' || kind === 'closed' ? '' : pull.head_sha
    return `${repo}#${pull.number} ${kind}${on ? ` ${on}` : ''}`
}

export class PullPoll {
    /** When each repo was last polled (or tried), and with a token or not, in this process. */
    private readonly last = new Map<string, {at: number, token: boolean}>()
    /** Repos whose token GitHub turned down, until when; and those said so in the log. */
    private readonly refused = new Map<string, number>()
    private readonly told401 = new Set<string>()
    private running = false

    constructor(
        private readonly store: Store,
        private readonly pulls: Pulls,
        /** Whether a token would go to GitHub for the project. */
        private readonly hasToken: (project: string) => Promise<boolean>,
        private readonly onChange: (change: PullChange) => void,
        private readonly note: (entry: EventEntry) => void,
        private readonly now: () => number = Date.now,
    ) {}

    /** Polls each repo that's due, one after another; a tick while the last is still going does nothing. */
    async tick(): Promise<void> {
        if (this.running) return
        this.running = true
        try {
            const repos = await this.pulls.repos()
            for (const [repo, projects] of repos) {
                try {
                    await this.pollIfDue(repo, projects)
                } catch (error) {
                    console.error(`[orrery] polling ${repo}'s pull requests:`, error)
                }
            }
            await this.forget([...repos.keys()])
        } finally {
            this.running = false
        }
    }

    private async pollIfDue(repo: string, projects: string[]) {
        const now = this.now()
        if ((this.refused.get(repo) ?? 0) > now) return
        // Asked as the first project's: the token's projects are checked against it.
        const [asker = ''] = projects
        const token = await this.hasToken(asker)
        const last = this.last.get(repo)
        if (last && last.token === token && now - last.at < (token ? POLL_EVERY : POLL_WITHOUT_TOKEN)) return
        this.last.set(repo, {at: now, token})
        await this.poll(repo, projects, asker, token)
    }

    /** Reads the repo's PRs, keeps what each is, and tells what changed. */
    async poll(repo: string, projects: string[], asker: string, token: boolean) {
        let read: {open: Polled[], done: Polled[]}
        try {
            read = token ? await this.graph(repo, asker) : await this.lists(repo, asker)
        } catch (error) {
            const message = (error as Error).message
            if (message.includes(`turned down the ${GITHUB_SECRET}`)) {
                this.refused.set(repo, this.now() + REFUSED_FOR)
                if (!this.told401.has(repo)) {
                    this.told401.add(repo)
                    this.note({level: 'warn', kind: 'github.refused', message: `GitHub turned down the ${GITHUB_SECRET} secret for ${repo}: pull requests aren't polled until it's set again with a token that works (tried again in an hour)`})
                }
            }
            await this.store.db.run(`INSERT INTO pull_repos (repo, polled_at, token, error) VALUES (?, ?, 0, ?)
                ON CONFLICT (repo) DO UPDATE SET error = excluded.error`, repo, new Date(this.now()).toISOString(), message)
            return
        }
        this.told401.delete(repo)
        const at = new Date(this.now()).toISOString()
        const first = !await this.store.db.get('SELECT 1 FROM pull_repos WHERE repo = ?', repo)
        const kept = new Map((await this.store.db.all<KeptPull>('SELECT * FROM pull_states WHERE repo = ?', repo)).map(k => [k.number, k]))
        const changes: PullChange[] = []
        const seen = new Set<number>()
        for (const pull of [...read.open, ...read.done]) {
            if (seen.has(pull.number)) continue
            seen.add(pull.number)
            const was = kept.get(pull.number)
            // One merged or closed before orrery kept it is nothing to it.
            if (!was && (pull.merged || pull.closed)) continue
            const names = issueIdsIn({body: pull.body, head: {ref: pull.branch}})
            const told = was ? JSON.parse(was.told) as string[] : []
            if (!first) {
                const issue = await this.pulls.issueOf(projects, names)
                for (const kind of changesOf(was, pull)) {
                    const key = keyOf(repo, pull, kind)
                    if (told.includes(key)) continue
                    told.push(key)
                    if (issue) changes.push({project: issue.project, issue: issue.id, repo, kind, key, pull: {number: pull.number, title: pull.title, url: pull.url, branch: pull.branch,
                        base: pull.base, head_sha: pull.head_sha, merge_sha: pull.merge_sha, closed_by: pull.closed_by, review_id: pull.review_id},
                        ...kind === 'changes_requested' ? {review: {by: pull.review_by ?? '', body: pull.review_body ?? '', comments: pull.review_comments ?? []}} : {},
                        ...kind === 'checks_failed' ? {failures: told.filter(k => k.startsWith(`${repo}#${pull.number} checks_failed`)).length} : {}})
                }
            }
            // A state this poll can't tell keeps the one it had; GitHub still working it out keeps the last it knew.
            const state = pull.state && (pull.state !== 'checking' || !was) ? pull.state : was?.state ?? 'checking'
            await this.store.db.run(`INSERT INTO pull_states (repo, number, names, title, url, branch, base, author, draft, head_sha, state, review, review_id, checks,
                merged, closed, merge_sha, closed_by, created_at, updated_at, seen_at, told) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (repo, number) DO UPDATE SET names = excluded.names, title = excluded.title, url = excluded.url, branch = excluded.branch,
                base = excluded.base, author = excluded.author, draft = excluded.draft, head_sha = excluded.head_sha, state = excluded.state,
                review = excluded.review, review_id = excluded.review_id, checks = excluded.checks, merged = excluded.merged, closed = excluded.closed,
                merge_sha = excluded.merge_sha, closed_by = excluded.closed_by, updated_at = excluded.updated_at, seen_at = excluded.seen_at, told = excluded.told`,
                repo, pull.number, JSON.stringify(names), pull.title, pull.url, pull.branch, pull.base, pull.author, pull.draft ? 1 : 0, pull.head_sha, state,
                pull.review ?? (token ? null : was?.review ?? null), pull.review_id ?? (token ? null : was?.review_id ?? null), pull.checks ?? (token ? null : was?.checks ?? null),
                pull.merged ? 1 : 0, pull.closed ? 1 : 0, pull.merge_sha, pull.closed_by, pull.created_at, pull.updated_at, at, JSON.stringify(told))
        }
        // Open when last seen, and in neither list now: closed or merged in a rush the lists missed. Kept as closed, told nothing.
        for (const [number, was] of kept) {
            if (!seen.has(number) && !was.merged && !was.closed) await this.store.db.run('UPDATE pull_states SET closed = 1, seen_at = ? WHERE repo = ? AND number = ?', at, repo, number)
        }
        await this.store.db.run(`INSERT INTO pull_repos (repo, polled_at, token, error) VALUES (?, ?, ?, NULL)
            ON CONFLICT (repo) DO UPDATE SET polled_at = excluded.polled_at, token = excluded.token, error = NULL`, repo, at, token ? 1 : 0)
        for (const change of changes) this.onChange(change)
    }

    private async graph(repo: string, asker: string): Promise<{open: Polled[], done: Polled[]}> {
        const [owner, name] = repo.split('/')
        const {value} = await this.pulls.ask<{data?: {repository: {open: {nodes: GraphPull[]}, done: {nodes: GraphPull[]}} | null}, errors?: {message: string}[]}>(
            repo, asker, '/graphql', {query: QUERY, variables: {owner, name}})
        if (value.errors?.length) throw new Error(`GitHub answered for ${repo}: ${value.errors.map(e => e.message).join('; ')}`)
        const found = value.data?.repository
        if (!found) throw new Error(`GitHub has no ${repo} that the ${GITHUB_SECRET} secret can read`)
        return {open: found.open.nodes.map(fromGraph), done: found.done.nodes.map(fromGraph)}
    }

    private async lists(repo: string, asker: string): Promise<{open: Polled[], done: Polled[]}> {
        const open = await this.pulls.ask<ListedPull[]>(repo, asker, `/repos/${repo}/pulls?state=open&per_page=100`)
        const done = await this.pulls.ask<ListedPull[]>(repo, asker, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${DONE}`)
        return {open: open.value.map(fromList), done: done.value.map(fromList)}
    }

    /** Lets go of merged and closed PRs a week on, and of repos nobody's project points at any more. */
    private async forget(repos: string[]) {
        const before = new Date(this.now() - KEEP).toISOString()
        await this.store.db.run('DELETE FROM pull_states WHERE (merged = 1 OR closed = 1) AND seen_at < ?', before)
        const gone = (await this.store.db.all<{repo: string}>('SELECT repo FROM pull_repos')).map(r => r.repo).filter(r => !repos.includes(r))
        for (const repo of gone) {
            await this.store.db.run('DELETE FROM pull_states WHERE repo = ?', repo)
            await this.store.db.run('DELETE FROM pull_repos WHERE repo = ?', repo)
            this.last.delete(repo)
        }
    }
}
