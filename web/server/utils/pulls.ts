// An issue's open pull requests, read from GitHub (ORR-485). Agents open a PR for each issue and link the issue's
// page in its body (ORR-223), or name the issue in its branch (`feat/orr-485-…`); orrery reads the project's repo's
// open PRs and keeps the ones that name the issue, with where each stands: a draft, conflicting, behind its base,
// failing checks, waiting on a review, or ready.
//
// Nothing is polled on its own: a page that shows an issue's PRs asks, and the answers are kept for a minute
// (five without a token, as GitHub allows 60 requests an hour then), so many pages and issues cost one list.
import type {IssuePulls, PullRequest, PullState} from '#shared/roadmap'
import {notFound} from './input'
import type {Store} from './store'

/** The secret orrery sends to api.github.com, when there's one that may go there. */
export const GITHUB_SECRET = 'GITHUB_TOKEN'
const API = 'https://api.github.com'
const FRESH = 60_000
const FRESH_WITHOUT_TOKEN = 5 * 60_000
/** The open PRs a repo's list reads: GitHub's largest page. */
const PAGE = 100

/** orrery's own GET to GitHub for a project: `secret` says whether a token went with it. */
export type GitHubGet = (url: string, project: string, headers: Record<string, string>) => Promise<{response: Response, secret: boolean}>

interface ListedPull {
    number: number
    title: string
    html_url: string
    draft?: boolean
    body: string | null
    user: {login: string} | null
    head: {ref: string}
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

        const list = await this.read(this.lists, repo, () => this.list(repo, project))
        const named = (list.value ?? []).filter(pull => namesIssue(pull, ids))
        const pulls: PullRequest[] = []
        let error = list.error
        for (const pull of named) {
            // A PR's state changes without it (its base moves on), so it's read again as often as the list.
            const state = await this.read(this.states, `${repo}#${pull.number}@${pull.updated_at}`, () => this.state(repo, project, pull))
            error ??= state.error
            pulls.push({
                number: pull.number,
                title: pull.title,
                url: pull.html_url,
                branch: pull.head.ref,
                base: pull.base.ref,
                author: pull.user?.login ?? '',
                state: state.value ?? (pull.draft ? 'draft' : 'checking'),
                created_at: pull.created_at,
                updated_at: pull.updated_at,
            })
        }
        this.forgetOld()
        return {repo, pulls, ...error ? {error} : {}, token: list.secret, checked_at: list.at ? new Date(list.at).toISOString() : null}
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
        return await this.ask<ListedPull[]>(repo, project, `/repos/${repo}/pulls?state=open&per_page=${PAGE}`)
    }

    private async state(repo: string, project: string, pull: ListedPull): Promise<{value: PullState, secret: boolean}> {
        if (pull.draft) return {value: 'draft', secret: false}
        const {value, secret} = await this.ask<{draft?: boolean, mergeable_state?: string}>(repo, project, `/repos/${repo}/pulls/${pull.number}`)
        return {value: pullState(value.draft, value.mergeable_state), secret}
    }

    private async ask<T>(repo: string, project: string, path: string): Promise<{value: T, secret: boolean}> {
        const {response, secret} = await this.get(`${API}${path}`, project, {
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'orrery',
        })
        if (response.ok) return {value: await response.json() as T, secret}
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

function limitMessage(until: number, secret?: boolean): string {
    const at = new Date(until).toISOString().slice(11, 16)
    return `GitHub's rate limit is used up until ${at} UTC${secret === false ? `; a ${GITHUB_SECRET} secret for api.github.com raises it` : ''}`
}
