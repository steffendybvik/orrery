import type {Issue} from '#shared/roadmap'
import {linkRef, parseLinkRef} from '#shared/roadmap'

// What waits on an issue, changed from its page as the owner (ORR-680): the link is kept on the waiting one, so setting
// it here adds this issue to that one's `depends_on`, or drops it, with the same checks. Its list is read fresh first,
// as the page may not have it. `failed` holds why the last change didn't go through.
export function useIssueBlocks(project: MaybeRefOrGetter<string>, issue: MaybeRefOrGetter<string>) {
    const {load} = useOwner()
    const failed = ref('')
    async function change(link: string, blocks: boolean): Promise<boolean> {
        const here = toValue(project)
        const other = parseLinkRef(here, link)
        const path = `/api/projects/${encodeURIComponent(other.project)}/issues/${encodeURIComponent(other.id)}`
        const self = linkRef(other.project, here, toValue(issue))
        failed.value = ''
        try {
            const waiting = (await $fetch<Issue>(path)).depends_on ?? []
            await $fetch(path, {
                method: 'PATCH', headers: {'Orrery-Actor': await load()},
                body: {depends_on: blocks ? [...waiting, self] : waiting.filter(ref => ref !== self)},
            })
            return true
        } catch (error) {
            failed.value = errorMessage(error)
            return false
        }
    }
    return {change, failed}
}
