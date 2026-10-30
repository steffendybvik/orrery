// The pull requests on the projects' GitHub repos, polled in the background (ORR-506): what each was is kept
// (pull_states), and a poll that finds one changed (conflicting, behind, failing its checks, changes requested, merged,
// closed, or back to ready or approved) says so once, as a `PullChange`, for what acts on it. The pages read what it
// keeps while it's fresh (pulls.ts).
//
// With a GITHUB_TOKEN secret each repo is one GraphQL query a minute: its open PRs, and those most recently merged or
// closed. Without one GitHub allows 60 requests an hour, so it's two REST lists every ten minutes, which say nothing of
// a PR's state but do say it merged or closed. A repo with more than 100 open costs a query (or list) more for each
// hundred, up to 300 read (ORR-615); past that it's cut short, says so on the page, and closes none it didn't read. A repo's first poll only records, as does its first with a token after
// polls without one: turning it on, or adding a token, tells nothing of the PRs already open. A rate limit holds the repo until GitHub's reset (shared with the pages); a refused token holds it an
// hour, or until the secrets change, said once in the event log until a poll works again.
import type {PullState} from '#shared/roadmap'
import {PULL_NEEDS} from '#shared/roadmap'
import type {EventEntry} from './event-log'
import type {KeptPull, ListedPull, Pulls} from './pulls'
import {GITHUB_SECRET, issueIdsIn, PAGE, PAGES, pullState} from './pulls'
import type {Store} from './store'

/** How often a repo is polled: with a token, and without one. */
const POLL_EVERY = 60_000
export const POLL_WITHOUT_TOKEN = 10 * 60_000
/** Without a token, how soon the owner's Poll now may poll a repo again after the last one they asked for, and after any
 * read: two of GitHub's 60 requests an hour each time, so pressing it as often as it allows, with the background poll,
 * costs at most 36 an hour a repo. */
const POLL_NOW_WITHOUT_TOKEN = 5 * 60_000
const READ_AGAIN_WITHOUT_TOKEN = 60_000
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
    /** For checks failed: how many times they have failed on this PR since they last went green, this one counted. */
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
        open: pullRequests(states: OPEN, first: ${PAGE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }
        done: pullRequests(states: [MERGED, CLOSED], first: ${DONE}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS}
            timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } } } }
    }
}`
/** The open PRs after the first page, while there are more (ORR-615). */
const OPEN_AFTER = `query($owner: String!, $name: String!, $after: String!) {
    repository(owner: $owner, name: $name) {
        open: pullRequests(states: OPEN, first: ${PAGE}, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${FIELDS} } pageInfo { hasNextPage endCursor } }
    }
}`

/** A page of a repo's PRs as GitHub's GraphQL gives it. */
interface GraphPage {
    nodes: GraphPull[]
    pageInfo?: {hasNextPage: boolean, endCursor: string | null}
}

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

/** A time as `HH:MM`, UTC. */
const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

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

/** How many times the PR's checks have failed (keys told, in order) since they last went green after failing. */
function failuresSincePassed(told: string[], pr: string): number {
    const since = told.findLastIndex(k => k.startsWith(`${pr} checks_passed`))
    return told.slice(since + 1).filter(k => k.startsWith(`${pr} checks_failed`)).length
}

/** The key that keeps a change to once: the PR, the kind, and what it's on. */
function keyOf(repo: string, pull: Polled, kind: PullChangeKind): string {
    const on = kind === 'changes_requested' ? pull.review_id ?? pull.head_sha : kind === 'merged' || kind === 'closed' ? '' : pull.head_sha
    return `${repo}#${pull.number} ${kind}${on ? ` ${on}` : ''}`
}

export class PullPoll {
    /** When each repo was last polled (or tried), and with a token or not, in this process. */
    private readonly last = new Map<string, {at: number, token: boolean}>()
    /** When the owner's Poll now last polled each repo without a token. */
    private readonly pressed = new Map<string, number>()
    /** Repos whose token GitHub turned down, until when; and those said so in the log. */
    private readonly refused = new Map<string, number>()
    private readonly told401 = new Set<string>()
    /** The pass under way, background or asked for, so another doesn't start beside it. */
    private running: Promise<Map<string, string>> | null = null
    /** The owner's Poll now under way, by the repo it's for ('' for every one): a second ask for the same gets its result. */
    private readonly asked = new Map<string, Promise<Map<string, string>>>()

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
        if (!this.running) await this.pass(false)
    }

    /** The owner's Poll now (ORR-534): every repo (or `only`), whenever it was last polled, once the pass under way
     * has finished; a second ask for the same while one runs gets its result. A repo GitHub is holding (a rate limit, a
     * refused token), or without a token one polled now in the last five minutes or read in the last minute, isn't asked: why, by repo. */
    async pollNow(only?: string): Promise<Map<string, string>> {
        const key = only ?? ''
        let asked = this.asked.get(key)
        if (!asked) {
            asked = (async () => {
                while (this.running) await this.running.catch(() => undefined)
                return await this.pass(true, only)
            })().finally(() => this.asked.delete(key))
            this.asked.set(key, asked)
        }
        return await asked
    }

    /** The secrets changed: a token GitHub turned down may have been set again, and a repo read without one may have
     * one now, so each repo whose token changed is polled at once rather than at its next turn (ORR-632). */
    async secretsChanged(): Promise<void> {
        this.refused.clear()
        this.told401.clear()
        if (!this.running) await this.pass(false).catch(() => undefined)
    }

    private async pass(force: boolean, only?: string): Promise<Map<string, string>> {
        const run = (async () => {
            const held = new Map<string, string>()
            const repos = await this.pulls.repos()
            for (const [repo, projects] of repos) {
                if (only && repo !== only) continue
                try {
                    const why = await this.pollIfDue(repo, projects, force)
                    if (why) held.set(repo, why)
                } catch (error) {
                    console.error(`[orrery] polling ${repo}'s pull requests:`, error)
                }
            }
            if (!only) await this.forget([...repos.keys()])
            return held
        })()
        this.running = run
        try {
            return await run
        } finally {
            this.running = null
        }
    }

    /** Polls the repo when it's due (`force`: whenever it was last polled); why it wasn't, when it was held. */
    private async pollIfDue(repo: string, projects: string[], force = false): Promise<string | undefined> {
        const now = this.now()
        const refused = this.refused.get(repo) ?? 0
        if (refused > now) return `GitHub turned down the ${GITHUB_SECRET} secret: tried again at ${clock(refused)} UTC, or once it's set again`
        const limited = this.pulls.limitedUntil(repo)
        if (force && limited) return `GitHub's rate limit is used up until ${clock(limited)} UTC`
        // Asked as the first project's: the token's projects are checked against it.
        const [asker = ''] = projects
        const token = await this.hasToken(asker)
        const last = this.last.get(repo)
        if (!force && last && last.token === token && now - last.at < (token ? POLL_EVERY : POLL_WITHOUT_TOKEN)) return
        if (force && !token) {
            const after = Math.max(last && !last.token ? last.at + READ_AGAIN_WITHOUT_TOKEN : 0, (this.pressed.get(repo) ?? 0) + POLL_NOW_WITHOUT_TOKEN)
            if (now < after) return `Read without a token a moment ago: it can be polled again at ${clock(after)} UTC (a GITHUB_TOKEN secret lifts this)`
            this.pressed.set(repo, now)
        }
        this.last.set(repo, {at: now, token})
        await this.poll(repo, projects, asker, token)
    }

    /** Reads the repo's PRs, keeps what each is, and tells what changed. */
    async poll(repo: string, projects: string[], asker: string, token: boolean) {
        let read: {open: Polled[], done: Polled[], more: boolean}
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
            // Said on a repo it has read before; one it never has stays unread, so its first good poll still only records (ORR-525).
            await this.store.db.run('UPDATE pull_repos SET error = ? WHERE repo = ?', message, repo)
            // And the pages say it too, rather than asking GitHub again straight after.
            this.pulls.failed(repo, message)
            return
        }
        this.told401.delete(repo)
        this.pulls.cutShort(repo, read.more ? read.open.length : undefined)
        const at = new Date(this.now()).toISOString()
        // Only records: the repo's first poll, and its first with a token after polls without one, which couldn't tell a
        // PR's state, checks or reviews, so every PR already conflicting or failing would read as news (ORR-525).
        const before = await this.store.db.get<{token: number}>('SELECT token FROM pull_repos WHERE repo = ?', repo)
        const first = !before || (token && !before.token)
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
            // Green again after failing (pending between, most often, while CI runs): the failures are counted afresh
            // from here (ORR-529).
            const passed = `${repo}#${pull.number} checks_passed ${pull.head_sha}`
            if (pull.checks === 'success' && failuresSincePassed(told, `${repo}#${pull.number}`) && !told.includes(passed)) told.push(passed)
            if (!first) {
                const issue = await this.pulls.issueOf(projects, names)
                for (const kind of changesOf(was, pull)) {
                    const key = keyOf(repo, pull, kind)
                    if (told.includes(key)) continue
                    told.push(key)
                    if (issue) changes.push({project: issue.project, issue: issue.id, repo, kind, key, pull: {number: pull.number, title: pull.title, url: pull.url, branch: pull.branch,
                        base: pull.base, head_sha: pull.head_sha, merge_sha: pull.merge_sha, closed_by: pull.closed_by, review_id: pull.review_id},
                        ...kind === 'changes_requested' ? {review: {by: pull.review_by ?? '', body: pull.review_body ?? '', comments: pull.review_comments ?? []}} : {},
                        ...kind === 'checks_failed' ? {failures: failuresSincePassed(told, `${repo}#${pull.number}`)} : {}})
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
        // Open when last seen, and in neither list now: closed or merged in a rush the lists missed. Kept as closed, told
        // nothing. Not when the open ones were cut short: those past the cut are still open (ORR-615).
        for (const [number, was] of kept) {
            if (!read.more && !seen.has(number) && !was.merged && !was.closed) await this.store.db.run('UPDATE pull_states SET closed = 1, seen_at = ? WHERE repo = ? AND number = ?', at, repo, number)
        }
        await this.store.db.run(`INSERT INTO pull_repos (repo, polled_at, token, error) VALUES (?, ?, ?, NULL)
            ON CONFLICT (repo) DO UPDATE SET polled_at = excluded.polled_at, token = excluded.token, error = NULL`, repo, at, token ? 1 : 0)
        for (const change of changes) this.onChange(change)
    }

    /** The repo's open PRs, a page a query up to `PAGES` of them, and the most recently done with the first; `more`
     * when GitHub had more open past the last page read (ORR-615). */
    private async graph(repo: string, asker: string): Promise<{open: Polled[], done: Polled[], more: boolean}> {
        const [owner, name] = repo.split('/')
        const query = async (text: string, after?: string) => {
            const {value} = await this.pulls.ask<{data?: {repository: {open: GraphPage, done?: GraphPage} | null}, errors?: {message: string}[]}>(
                repo, asker, '/graphql', {query: text, variables: {owner, name, ...after ? {after} : {}}})
            if (value.errors?.length) throw new Error(`GitHub answered for ${repo}: ${value.errors.map(e => e.message).join('; ')}`)
            const found = value.data?.repository
            if (!found) throw new Error(`GitHub has no ${repo} that the ${GITHUB_SECRET} secret can read`)
            return found
        }
        const first = await query(QUERY)
        const open = first.open.nodes.map(fromGraph)
        let page = first.open.pageInfo
        for (let read = 1; page?.hasNextPage && page.endCursor && read < PAGES; read++) {
            const next = (await query(OPEN_AFTER, page.endCursor)).open
            open.push(...next.nodes.map(fromGraph))
            page = next.pageInfo
        }
        return {open, done: (first.done?.nodes ?? []).map(fromGraph), more: !!page?.hasNextPage}
    }

    private async lists(repo: string, asker: string): Promise<{open: Polled[], done: Polled[], more: boolean}> {
        const open = await this.pulls.askPages<ListedPull>(repo, asker, `/repos/${repo}/pulls?state=open&per_page=${PAGE}`)
        const done = await this.pulls.ask<ListedPull[]>(repo, asker, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${DONE}`)
        return {open: open.value.map(fromList), done: done.value.map(fromList), more: open.more}
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
            this.pressed.delete(repo)
        }
    }
}
