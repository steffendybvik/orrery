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

/** An issue's open pull requests, as GitHub had them when orrery last asked. */
export interface IssuePulls {
    /** The project's repo on GitHub (`you/shop`), or null when it has none there: then nothing is asked. */
    repo: string | null
    pulls: PullRequest[]
    /** Why GitHub couldn't be read (its rate limit, a private repo without a token…); `pulls` is then the last it gave, if any. */
    error?: string
    /** Whether a GITHUB_TOKEN secret went with the request (one that may go to api.github.com, for this project). */
    token: boolean
    checked_at: string | null
}

/** Where a PR stands when it needs someone before it can merge: it conflicts, fails its checks, or is behind its base. */
export const PULL_NEEDS: PullState[] = ['conflicting', 'failing', 'behind']

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
    pulls: OpenPull[]
    needs: number
    /** `held`: why Poll now didn't ask GitHub for the repo (a rate limit, a refused token, or polled without one a moment ago). */
    repos: {repo: string, projects: string[], token: boolean, checked_at: string | null, error?: string, held?: string}[]
}
