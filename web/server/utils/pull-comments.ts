// What orrery says on an issue when the poll (pull-poll.ts) finds its pull request conflicting, behind, merged or
// closed (ORR-507): a comment of its own, once per change, which the session on the issue hears like the owner's
// (store `systemComment`), and an event (`pr.conflicting`, `pr.behind`, `pr.merged`, `pr.closed`) a schedule can hang
// on. It changes no status: the session, or the owner, does. Only what orrery knows goes in its words: the PR's number,
// its base branch, the merge commit and who closed it. Never the PR's title or its branch, which an outsider may have
// written, as a session reads these as the owner's.
import type {PullChange, PullChangeKind} from './pull-poll'
import type {Store} from './store'

/** The changes that are told on the issue. */
export const TOLD: PullChangeKind[] = ['conflicting', 'behind', 'merged', 'closed']

/** What orrery says about the change, in Markdown; none for one it doesn't tell. */
export function pullComment({repo, kind, pull}: PullChange): string | null {
    const pr = `[#${pull.number}](https://github.com/${repo}/pull/${pull.number})`
    const base = `\`${pull.base}\``
    switch (kind) {
        case 'conflicting': return `${pr} conflicts with ${base}: merge ${base} into it and resolve the conflicts before it can merge.`
        case 'behind': return `${pr} is behind ${base}: update it from ${base} before it can merge.`
        case 'merged': return `${pr} was merged into ${base}${pull.merge_sha ? ` as \`${pull.merge_sha.slice(0, 7)}\`` : ''}.`
        case 'closed': return `${pr} was closed without merging${pull.closed_by && /^[\w-]+$/.test(pull.closed_by) ? ` by ${pull.closed_by}` : ''}.`
        default: return null
    }
}

/** Tells the change on its issue, if it's one that's told. A failure is logged, not thrown: the poll goes on. */
export async function commentOnPull(store: Store, change: PullChange): Promise<void> {
    const body = pullComment(change)
    if (!body) return
    try {
        await store.systemComment(change.project, change.issue, body, `pr.${change.kind}`)
    } catch (error) {
        console.error(`[orrery] telling ${change.issue} about ${change.repo}#${change.pull.number}:`, error)
    }
}
