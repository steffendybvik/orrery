// An issue's open pull requests, read from GitHub (ORR-485). Agents open a PR for each issue and link the issue's
// page in its body (ORR-223), or name the issue in its branch (`feat/orr-485-…`); orrery reads the project's repo's
// open PRs and keeps the ones that name the issue, with where each stands: a draft, conflicting, behind its base,
// failing checks, waiting on a review, or ready.
//
// A page that shows an issue's PRs, or the Pull requests page and the sidebar's count of those needing someone
// (ORR-491), asks. While the poll (pull-poll.ts) has just read the repo with a token, they're read off what it keeps;
// otherwise GitHub is asked, and the answers kept for a minute (five without a token, as GitHub allows 60 requests an
// hour then), so many pages and issues cost one list per repo.
import type {AllPulls, IssuePulls, OpenPull, PullRequest, PullState} from '#shared/roadmap'
import {PULL_NEEDS} from '#shared/roadmap'
import {notFound} from './input'
import type {Store} from './store'

/** The secret orrery sends to api.github.com, when there's one that may go there. */
export const GITHUB_SECRET = 'GITHUB_TOKEN'
const API = 'https://api.github.com'
const FRESH = 60_000
const FRESH_WITHOUT_TOKEN = 5 * 60_000
/** The open PRs a page of a repo's list reads: GitHub's largest. */
export const PAGE = 100
/** The most pages of a repo's open PRs read, following GitHub's `Link: rel="next"` (ORR-615): 300 PRs, for three
 * requests a read. A repo with more is cut short, and says so. */
export const PAGES = 3

/** orrery's own request to GitHub for a project (a GET, or a POST with `init`): `secret` says whether a token went with it. */
export type GitHubGet = (url: string, project: string, headers: Record<string, string>, init?: {method?: 'GET' | 'POST', body?: string})
    => Promise<{response: Response, secret: boolean}>

/** How long what the poll keeps of a repo stands in for asking GitHub: a few of its minutes, so one late poll doesn't
 * send every page to GitHub. */
const POLL_STANDS = 3 * 60_000

/** A PR as the poll keeps it (pull_states). */
export interface KeptPull {
    repo: string
    number: number
    names: string
    title: string
    url: string
    branch: string
    base: string
    author: string
    draft: number
    head_sha: string | null
    state: PullState
    review: string | null
    review_id: string | null
    checks: string | null
    merged: number
    closed: number
    merge_sha: string | null
    closed_by: string | null
    created_at: string
    updated_at: string
    seen_at: string
    told: string
}

/** A PR as GitHub's REST lists it. */
export interface ListedPull {
    number: number
    title: string
    html_url: string
    draft?: boolean
    body: string | null
    user: {login: string} | null
    head: {ref: string, sha?: string}
    merged_at?: string | null
    merge_commit_sha?: string | null
    base: {ref: string}
    created_at: string
    updated_at: string
}

interface Read<T> {
    at: number
    fresh: number
    value?: T
    error?: string
    secret: boolean
}

/** The repo's `owner/name` on GitHub, from its web address; null for anywhere else. */
export function githubRepo(repo: string | null | undefined): string | null {
    const match = repo?.trim().match(/^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    return match ? `${match[1]}/${match[2]}` : null
}

/** Whether a PR names one of the issue's ids: a link to its page in the body, or the id in its branch. */
export function namesIssue(pull: Pick<ListedPull, 'body' | 'head'>, ids: string[]): boolean {
    return ids.some(id => {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return new RegExp(`/issues/${escaped}(?![\\w-])`, 'i').test(pull.body ?? '')
            || new RegExp(`(?:^|[^a-z0-9])${escaped}(?![0-9])`, 'i').test(pull.head.ref)
    })
}

/** The issue ids a PR names, most likely first: those its body links to (`…/issues/ORR-12`), then its branch's
 * (`feat/orr-12-…`), as they'd be written (upper case). */
export function issueIdsIn(pull: Pick<ListedPull, 'body' | 'head'>): string[] {
    const ids = [
        ...[...(pull.body ?? '').matchAll(/\/issues\/([a-z][a-z0-9]*-\d+)(?![\w-])/gi)].map(m => m[1]),
        ...[...pull.head.ref.matchAll(/(?:^|[^a-z0-9])([a-z][a-z0-9]*-\d+)(?![0-9])/gi)].map(m => m[1]),
    ]
    return [...new Set(ids.filter(id => id !== undefined).map(id => id.toUpperCase()))]
}

/** Where a PR stands, from its draft flag and GitHub's `mergeable_state`. */
export function pullState(draft: boolean | undefined, mergeable: string | null | undefined): PullState {
    if (draft) return 'draft'
    switch (mergeable) {
        case 'dirty': return 'conflicting'
        case 'behind': return 'behind'
        case 'unstable': return 'failing'
        case 'blocked': return 'blocked'
        case 'clean':
        case 'has_hooks': return 'ready'
        default: return 'checking'
    }
}

export class Pulls {
    private readonly lists = new Map<string, Read<ListedPull[]>>()
    private readonly states = new Map<string, Read<PullState>>()
    private readonly asking = new Map<string, Promise<unknown>>()
    /** Until when GitHub said no more, per repo: nothing is asked of it before then. */
    private readonly limited = new Map<string, number>()
    /** The repos whose open PRs were cut short at `PAGES` when last read, with how many were read (ORR-615). */
    private readonly cut = new Map<string, number>()

    constructor(
        private readonly store: Store,
        private readonly get: GitHubGet,
        private readonly now: () => number = Date.now,
    ) {}

    /** The issue's open PRs on its project's repo. */
    async forIssue(project: string, issue: string): Promise<IssuePulls> {
        project = await this.store.projectId(project)
        const ids = await this.ids(project, issue)
        const row = await this.store.db.get<{repo: string | null}>('SELECT repo FROM projects WHERE id = ?', project)
        const repo = githubRepo(row?.repo)
        if (!repo) return {repo: null, pulls: [], token: false, checked_at: null}

        const kept = await this.kept(repo)
        if (kept) {
            const wanted = ids.map(id => id.toUpperCase())
            const pulls = kept.pulls.filter(pull => (JSON.parse(pull.names) as string[]).some(id => wanted.includes(id))).map(pull => keptShown(pull))
            return {repo, pulls, ...kept.error ? {error: kept.error} : {}, token: true, checked_at: kept.checked_at}
        }
        const list = await this.read(this.lists, repo, () => this.list(repo, project))
        const named = (list.value ?? []).filter(pull => namesIssue(pull, ids))
        const pulls: PullRequest[] = []
        let error = list.error
        for (const pull of named) {
            // A PR's state changes without it (its base moves on), so it's read again as often as the list.
            const state = await this.read(this.states, `${repo}#${pull.number}@${pull.updated_at}`, () => this.state(repo, project, pull))
            error ??= state.error
            pulls.push(this.shown(pull, state.value ?? (pull.draft ? 'draft' : 'checking')))
        }
        this.forgetOld()
        return {repo, pulls, ...error ? {error} : {}, token: list.secret, checked_at: list.at ? new Date(list.at).toISOString() : null}
    }

    /** Every open PR on the projects' GitHub repos, each repo read once however many projects share it, with the issue
     * it names. Their states are read only with a token: without one, GitHub's 60 requests an hour go to the lists. */
    async all(): Promise<AllPulls> {
        const pulls: OpenPull[] = []
        const repos: AllPulls['repos'] = []
        for (const [repo, projects] of await this.repos()) {
            // Without a token this shows only the list, as the poll keeps it, so a poll without one serves too.
            const kept = await this.kept(repo, true)
            if (kept) {
                for (const pull of kept.pulls) {
                    const issue = await this.issueOf(projects, JSON.parse(pull.names) as string[])
                    // Read without a token, the state kept is the last one a token told: maybe long gone.
                    const shown = kept.token ? keptShown(pull) : {...keptShown(pull), state: pull.draft ? 'draft' as const : 'checking' as const}
                    pulls.push({...shown, repo, ...issue ? {issue} : {}})
                }
                repos.push({repo, projects, token: kept.token, checked_at: kept.checked_at, open: 0, needs: 0, ...kept.error ? {error: kept.error} : {}, ...this.cutAt(repo)})
                continue
            }
            // Asked as the first project's: the token's projects are checked against it.
            const [asker = ''] = projects
            const list = await this.read(this.lists, repo, () => this.list(repo, asker))
            let error = list.error
            for (const pull of list.value ?? []) {
                let state: PullState = pull.draft ? 'draft' : 'checking'
                if (list.secret) {
                    const read = await this.read(this.states, `${repo}#${pull.number}@${pull.updated_at}`, () => this.state(repo, asker, pull))
                    error ??= read.error
                    state = read.value ?? state
                }
                const issue = await this.issueOf(projects, issueIdsIn(pull))
                pulls.push({...this.shown(pull, state), repo, ...issue ? {issue} : {}})
            }
            repos.push({repo, projects, token: list.secret, checked_at: list.at ? new Date(list.at).toISOString() : null, open: 0, needs: 0, ...error ? {error} : {}, ...this.cutAt(repo)})
        }
        this.forgetOld()
        const needs = (pull: OpenPull) => PULL_NEEDS.includes(pull.state)
        pulls.sort((a, b) => Number(needs(b)) - Number(needs(a)) || a.created_at.localeCompare(b.created_at))
        for (const repo of repos) {
            const own = pulls.filter(p => p.repo === repo.repo)
            repo.open = own.length
            repo.needs = own.filter(needs).length
        }
        return {pulls, open: pulls.length, needs: pulls.filter(needs).length, repos}
    }

    /** The poll read the repo's open PRs: cut short after `read` of them, or (undefined) all of them. */
    cutShort(repo: string, read: number | undefined) {
        if (read === undefined) this.cut.delete(repo)
        else this.cut.set(repo, read)
    }

    private cutAt(repo: string): {cut?: number} {
        const read = this.cut.get(repo)
        return read === undefined ? {} : {cut: read}
    }

    /** Until when GitHub's rate limit holds the repo, while it does. */
    limitedUntil(repo: string): number | undefined {
        const until = this.limited.get(repo)
        return until && this.now() < until ? until : undefined
    }

    /** The poll couldn't read the repo: its list says why for a minute, keeping what it had, rather than asking again. */
    failed(repo: string, error: string) {
        const kept = this.lists.get(repo)
        this.lists.set(repo, {...kept ?? {secret: false}, at: this.now(), fresh: FRESH, error})
    }

    /** The projects' GitHub repos, each with the projects on it, oldest first. */
    async repos(): Promise<Map<string, string[]>> {
        const rows = await this.store.db.all<{id: string, repo: string | null}>('SELECT id, repo FROM projects ORDER BY created_at, id')
        const byRepo = new Map<string, string[]>()
        for (const row of rows) {
            const repo = githubRepo(row.repo)
            if (repo) byRepo.set(repo, [...byRepo.get(repo) ?? [], row.id])
        }
        return byRepo
    }

    /** The repo's open PRs as the poll keeps them, while it read them with a token in the last few minutes (or without
     * one, `listOnly`, for a reader that shows only the list then); else none, and GitHub is asked. */
    private async kept(repo: string, listOnly = false): Promise<{pulls: KeptPull[], checked_at: string, token: boolean, error?: string} | null> {
        const polled = await this.store.db.get<{polled_at: string, token: number, error: string | null}>('SELECT polled_at, token, error FROM pull_repos WHERE repo = ?', repo)
        if (!polled || (!polled.token && !listOnly) || this.now() - Date.parse(polled.polled_at) > POLL_STANDS) return null
        const pulls = await this.store.db.all<KeptPull>('SELECT * FROM pull_states WHERE repo = ? AND merged = 0 AND closed = 0 ORDER BY number', repo)
        return {pulls, checked_at: polled.polled_at, token: !!polled.token, ...polled.error ? {error: polled.error} : {}}
    }

    /** The first of the ids that's an issue (or one it had before) in one of the projects. */
    async issueOf(projects: string[], ids: string[]): Promise<OpenPull['issue']> {
        const among = projects.map(() => '?').join(', ')
        for (const id of ids) {
            const found = await this.store.db.get<{project: string, id: string, title: string}>(
                `SELECT project, id, title FROM issues WHERE project IN (${among}) AND id = ?`, ...projects, id)
                ?? await this.store.db.get<{project: string, id: string, title: string}>(
                    `SELECT i.project, i.id, i.title FROM issue_aliases a JOIN issues i ON i.project = a.project AND i.id = a.issue WHERE a.project IN (${among}) AND a.alias = ?`, ...projects, id)
            if (found) return found
        }
        return undefined
    }

    private shown(pull: ListedPull, state: PullState): PullRequest {
        return {
            number: pull.number,
            title: pull.title,
            url: pull.html_url,
            branch: pull.head.ref,
            base: pull.base.ref,
            author: pull.user?.login ?? '',
            state,
            created_at: pull.created_at,
            updated_at: pull.updated_at,
        }
    }

    /** The issue's id and the ids it had before; a 404 when there's no such issue. */
    private async ids(project: string, issue: string): Promise<string[]> {
        const id = (await this.store.db.get<{issue: string}>('SELECT issue FROM issue_aliases WHERE project = ? AND alias = ?', project, issue))?.issue ?? issue
        if (!await this.store.db.get('SELECT 1 FROM issues WHERE project = ? AND id = ?', project, id)) {
            throw notFound(`No issue ${issue} in ${project}`)
        }
        const aliases = await this.store.db.all<{alias: string}>('SELECT alias FROM issue_aliases WHERE project = ? AND issue = ?', project, id)
        return [id, ...aliases.map(a => a.alias)]
    }

    /** What's kept for `key` while it's fresh, else read again (once, however many ask); a failed read keeps the last value. */
    private async read<T>(cache: Map<string, Read<T>>, key: string, fetch: () => Promise<{value: T, secret: boolean}>): Promise<Read<T>> {
        const kept = cache.get(key)
        const now = this.now()
        if (kept && now - kept.at < kept.fresh) return kept
        const repo = key.replace(/#.*$/, '')
        const until = this.limited.get(repo)
        if (until && now < until) return {...kept ?? {at: 0, fresh: 0, secret: false}, error: limitMessage(until)}

        const asked = `${cache === this.lists ? 'list' : 'state'}:${key}`
        let pending = this.asking.get(asked) as Promise<Read<T>> | undefined
        if (!pending) {
            pending = (async () => {
                try {
                    const {value, secret} = await fetch()
                    const read: Read<T> = {at: this.now(), fresh: secret ? FRESH : FRESH_WITHOUT_TOKEN, value, secret}
                    cache.set(key, read)
                    return read
                } catch (error) {
                    const failed: Read<T> = {...kept ?? {secret: false}, at: this.now(), fresh: FRESH, error: (error as Error).message}
                    cache.set(key, failed)
                    return failed
                } finally {
                    this.asking.delete(asked)
                }
            })()
            this.asking.set(asked, pending)
        }
        return await pending
    }

    private async list(repo: string, project: string): Promise<{value: ListedPull[], secret: boolean}> {
        const {value, secret, more} = await this.askPages<ListedPull>(repo, project, `/repos/${repo}/pulls?state=open&per_page=${PAGE}`)
        // A PR opened or closed between two pages shifts the rest, so one can be on both.
        const once = [...new Map(value.map(pull => [pull.number, pull])).values()]
        this.cutShort(repo, more ? once.length : undefined)
        return {value: once, secret}
    }

    private async state(repo: string, project: string, pull: ListedPull): Promise<{value: PullState, secret: boolean}> {
        if (pull.draft) return {value: 'draft', secret: false}
        const {value, secret} = await this.ask<{draft?: boolean, mergeable_state?: string}>(repo, project, `/repos/${repo}/pulls/${pull.number}`)
        return {value: pullState(value.draft, value.mergeable_state), secret}
    }

    /** Asks GitHub `path` for the repo, as the project's (a POST with `body`, for GraphQL): what it answered, and whether
     * a token went. A rate limit holds the repo until GitHub's reset, for the poll and the pages alike. */
    async ask<T>(repo: string, project: string, path: string, body?: unknown): Promise<{value: T, secret: boolean}> {
        const {value, secret} = await this.request<T>(repo, project, path, body)
        return {value, secret}
    }

    /** Asks GitHub for the list at `path`, and for the pages after it while its `Link` header names a next one, up to
     * `PAGES` (ORR-615): everything read, whether a token went, and whether GitHub had more past the last page read. */
    async askPages<T>(repo: string, project: string, path: string): Promise<{value: T[], secret: boolean, more: boolean}> {
        const value: T[] = []
        let secret = false
        let next: string | undefined = path
        for (let page = 0; next && page < PAGES; page++) {
            const read: {value: T[], secret: boolean, next?: string} = await this.request<T[]>(repo, project, next)
            value.push(...read.value)
            secret ||= read.secret
            // Only ever on to api.github.com, whatever the header says.
            next = read.next?.startsWith(`${API}/`) ? read.next.slice(API.length) : undefined
        }
        return {value, secret, more: !!next}
    }

    private async request<T>(repo: string, project: string, path: string, body?: unknown): Promise<{value: T, secret: boolean, next?: string}> {
        const until = this.limited.get(repo)
        if (until && this.now() < until) throw new Error(limitMessage(until))
        const {response, secret} = await this.get(`${API}${path}`, project, {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'orrery',
            ...body === undefined ? {} : {'Content-Type': 'application/json'},
        }, body === undefined ? undefined : {method: 'POST', body: JSON.stringify(body)})
        if (response.ok) {
            const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1]
            return {value: await response.json() as T, secret, ...next ? {next} : {}}
        }
        const left = response.headers.get('x-ratelimit-remaining')
        if (response.status === 429 || (response.status === 403 && left === '0')) {
            const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
            const until = reset > this.now() ? reset : this.now() + FRESH
            this.limited.set(repo, until)
            throw new Error(limitMessage(until, secret))
        }
        if (response.status === 401) throw new Error(`GitHub turned down the ${GITHUB_SECRET} secret: set it again with a token that works`)
        if (response.status === 404) {
            throw new Error(secret ? `GitHub has no ${repo} that the ${GITHUB_SECRET} secret can read`
                : `GitHub has no public ${repo}: for a private repo, set a ${GITHUB_SECRET} secret that may go to api.github.com`)
        }
        throw new Error(`GitHub answered ${response.status} for ${repo}`)
    }

    /** Drops what's long stale (PRs since merged, or updated), so the caches don't grow with every PR there was. */
    private forgetOld() {
        const now = this.now()
        for (const cache of [this.lists, this.states] as Map<string, Read<unknown>>[]) {
            for (const [key, read] of cache) if (now - read.at > 10 * FRESH_WITHOUT_TOKEN) cache.delete(key)
        }
    }
}

/** A PR the poll keeps, as the pages show it. */
function keptShown(pull: KeptPull): PullRequest {
    return {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        branch: pull.branch,
        base: pull.base,
        author: pull.author,
        state: pull.state,
        created_at: pull.created_at,
        updated_at: pull.updated_at,
    }
}

function limitMessage(until: number, secret?: boolean): string {
    const at = new Date(until).toISOString().slice(11, 16)
    return `GitHub's rate limit is used up until ${at} UTC${secret === false ? `; a ${GITHUB_SECRET} secret for api.github.com raises it` : ''}`
}

/** How many pull requests a page of `GET /api/pulls` holds unless asked otherwise, and at most (ORR-615). */
export const PULLS_PAGE = 50
const PULLS_PAGE_MOST = 200

/** `all` as `?page=&limit=` asks (ORR-615): every one when neither is given, else page `page` (from 1), `limit` to a
 * page, in the same order. The counts, the repos' included, stay totals. A page past the last is the last, so a
 * refresh after PRs close still has a page to show. */
export function pullsPage(all: AllPulls, query: {page?: unknown, limit?: unknown}): AllPulls {
    if (query.page === undefined && query.limit === undefined) return all
    // A whole number from 1, else `or`.
    const counted = (value: unknown, or: number) => {
        const n = Math.floor(Number(value))
        return n >= 1 ? n : or
    }
    const limit = Math.min(counted(query.limit, PULLS_PAGE), PULLS_PAGE_MOST)
    const page = Math.min(counted(query.page, 1), Math.max(1, Math.ceil(all.pulls.length / limit)))
    return {...all, pulls: all.pulls.slice((page - 1) * limit, page * limit), page, limit}
}
