// Pull requests on the projects' repos, and where each stands.

/** Where an open pull request stands: what it waits on before it can merge (ORR-485). */
export type PullState = 'draft' | 'conflicting' | 'behind' | 'failing' | 'blocked' | 'ready' | 'checking'

/** An open pull request on the project's repo that names the issue: in its body (a link to the issue's page), or in its branch. */
export interface PullRequest {
    number: number
    title: string
    url: string
    /** Its branch, and the one it merges into. */
    branch: string
    base: string
    author: string
    state: PullState
    created_at: string
    updated_at: string
}

/** What a session is asked to do about a PR that can't merge as it is (Send back, ORR-492); none for one that can. */
export function sendBackNote(pull: Pick<PullRequest, 'number' | 'url' | 'base' | 'state'>): string | null {
    // Never its head branch, which an outsider may have named: this goes to the session as the owner's words (ORR-532).
    const which = `Its PR #${pull.number} (into ${pull.base}, ${pull.url})`
    switch (pull.state) {
        case 'conflicting': return `${which} conflicts with ${pull.base}: check it out (gh pr checkout ${pull.number}), merge ${pull.base} into it, resolve the conflicts, run the checks and push.`
        case 'behind': return `${which} is behind ${pull.base}: check it out (gh pr checkout ${pull.number}), merge ${pull.base} into it, run the checks and push.`
        case 'failing': return `${which} fails its checks: read them (gh pr checks ${pull.number}), fix what fails and push.`
        default: return null
    }
}

/** What a session is asked to do about a PR from the Pull requests page's Focus on this (ORR-607): Send back's note for
 * one that can't merge, and for the rest what its state asks, so the session can start without asking what's wrong. */
export function focusNote(pull: Pick<PullRequest, 'number' | 'url' | 'base' | 'state'>): string {
    const back = sendBackNote(pull)
    if (back) return back
    // Never its head branch either (ORR-532).
    const which = `Its PR #${pull.number} (into ${pull.base}, ${pull.url})`
    switch (pull.state) {
        case 'blocked': return `${which} waits on a review or a required check: see what it waits on (gh pr view ${pull.number} --comments, gh pr checks ${pull.number}), answer the review and push what it asks for.`
        case 'draft': return `${which} is a draft: check it out (gh pr checkout ${pull.number}), finish what the issue asks, run the checks, push and mark it ready (gh pr ready ${pull.number}).`
        case 'ready': return `${which} is ready to merge: check it does what the issue asks (gh pr view ${pull.number}, gh pr diff ${pull.number}), and say on the issue that it's ready, or fix what isn't.`
        default: return `Look at its PR #${pull.number} (into ${pull.base}, ${pull.url}) and take it forward: see where it stands (gh pr view ${pull.number}, gh pr checks ${pull.number}).`
    }
}

/** An issue's open pull requests, as GitHub had them when orrery last asked. */
/** A PR an issue keeps once it's no longer among the open ones it reads (ORR-795). `open`: only for a repo the project has
 * since left, as it stood when last seen. */
export interface PastPull {
    number: number
    title: string
    url: string
    branch: string
    base: string
    author: string
    state: 'open' | 'merged' | 'closed'
    merged_at: string | null
    updated_at: string
}

export interface IssuePulls {
    /** The project's repo on GitHub (`you/shop`), or null when it has none there: then nothing is asked. */
    repo: string | null
    pulls: PullRequest[]
    /** Those merged or closed, newest first, however long ago: asked of orrery's own record, never of GitHub. */
    done: PastPull[]
    /** Why GitHub couldn't be read (its rate limit, a private repo without a token…); `pulls` is then the last it gave, if any. */
    error?: string
    /** Whether a GITHUB_TOKEN secret went with the request (one that may go to api.github.com, for this project). */
    token: boolean
    /** Why a GITHUB_TOKEN secret that's set didn't go (ORR-632): its hosts or projects leave this out, or it can't be opened. */
    token_problem?: string
    checked_at: string | null
}

/** Where a PR stands when it needs someone before it can merge: it conflicts, fails its checks, or is behind its base. */
export const PULL_NEEDS: PullState[] = ['conflicting', 'failing', 'behind']

/** A page's cards in the projects' order, as the sidebar has them (ORR-607): the Pull requests page's repos, or the
 * Releases page's sources. One shared by several projects goes where the first of them is; one with no project in
 * `order`, after, by `name`. */
export function inProjectOrder<T extends {projects: string[]}>(cards: T[], order: string[], name: (card: T) => string): T[] {
    const at = (card: T) => Math.min(...card.projects.map(p => order.indexOf(p)).filter(i => i >= 0), Number.MAX_SAFE_INTEGER)
    return [...cards].sort((a, b) => at(a) - at(b) || name(a).localeCompare(name(b)))
}

/** An open pull request on one of the projects' repos, for the Pull requests page (ORR-491): the issue it names, when
 * one of the repo's projects has it. */
export interface OpenPull extends PullRequest {
    /** The repo on GitHub (`you/shop`). */
    repo: string
    issue?: {project: string, id: string, title: string}
}

/** Every open pull request on the projects' GitHub repos: those that need someone (`PULL_NEEDS`) first, oldest first,
 * then the rest, oldest first; `needs` counts the first. Each repo says whether a token went, and why it couldn't be
 * read when it couldn't. Without a token only the list is read, as GitHub allows 60 requests an hour then, so every PR
 * not a draft is `checking`. */
export interface AllPulls {
    /** Every one, or one page of them when `page` is asked for (ORR-615). */
    pulls: OpenPull[]
    /** How many are open, and how many of those need someone, on every page. */
    open: number
    needs: number
    /** The page `pulls` is (from 1), and how many go on one, when paged. */
    page?: number
    limit?: number
    /** `open` and `needs` are the repo's, on every page. `cut`: GitHub had more open than orrery reads (300), and
     * this many were read. `held`: why Poll now didn't ask GitHub for the repo (a rate limit, a refused token, or
     * polled without one a moment ago). */
    repos: {repo: string, projects: string[], token: boolean, token_problem?: string, checked_at: string | null, open: number, needs: number, cut?: number, error?: string, held?: string}[]
}

/** What to do with a branch: remove it, keep it, or look at it first (ORR-793). */
export type BranchVerdict = 'remove' | 'keep' | 'look'

export interface RepoBranch {
    repo: string
    name: string
    sha: string
    /** Its last commit; null read without a token. */
    committed_at: string | null
    /** Commits not in `base`; null read without a token. A squash merge leaves a branch's commits reading as not in it. */
    ahead: number | null
    /** The issue its name names, when a project has it. */
    issue?: {project: string, id: string, title: string, kind: string}
    pull?: {number: number, url: string, state: 'open' | 'merged' | 'closed'}
    verdict: BranchVerdict
    why: string
}

export interface AllBranches {
    branches: RepoBranch[]
    repos: {repo: string, projects: string[], base: string | null, token: boolean, error?: string, cut?: number}[]
}

/** What's known of a branch, for its verdict. */
export interface BranchFacts {
    /** The repo's default branch, or the branch of a release being prepared. */
    held: boolean
    sha: string
    ahead: number | null
    /** `head_sha` when the PR's last commit is known. */
    pull?: {state: 'open' | 'merged' | 'closed', head_sha?: string | null}
    issueKind?: string
    /** A session that's listening has the branch's issue started. */
    worked: boolean
}

/** Keep what's in use, remove what has nothing left to bring in, and leave the rest for someone to look at. Only a merged
 * PR with no commits since, or no commits past the base, reads as remove: a squash merge makes commit counts alone say unmerged. */
export function branchVerdict(branch: BranchFacts): {verdict: BranchVerdict, why: string} {
    if (branch.held) return {verdict: 'keep', why: 'The default branch, or a release being prepared'}
    if (branch.pull?.state === 'open') return {verdict: 'keep', why: 'Its pull request is open'}
    if (branch.worked) return {verdict: 'keep', why: 'A session is on its issue'}
    if (branch.pull?.state === 'merged') {
        return branch.pull.head_sha && branch.pull.head_sha !== branch.sha
            ? {verdict: 'look', why: 'It has commits since its pull request merged'}
            : {verdict: 'remove', why: 'Its pull request merged'}
    }
    if (branch.ahead === 0) return {verdict: 'remove', why: 'It has nothing left to bring in'}
    if (branch.pull?.state === 'closed') return {verdict: 'look', why: 'Its pull request closed without merging'}
    if (branch.issueKind === 'done' || branch.issueKind === 'canceled') return {verdict: 'look', why: 'Its issue is finished, and it has commits left'}
    return {verdict: 'look', why: 'It has no pull request'}
}
