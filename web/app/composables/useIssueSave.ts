// Changing an issue from its page, as the owner: the page catches up from `/api/events` once it's saved.
// `failed` holds why the last save didn't go through.
export function useIssueSave(project: MaybeRefOrGetter<string>, issue: MaybeRefOrGetter<string>) {
    const saving = ref(false)
    const failed = ref('')
    async function save(body: Record<string, unknown>): Promise<boolean> {
        saving.value = true
        failed.value = ''
        try {
            await apiFetch(`/projects/${encodeURIComponent(toValue(project))}/issues/${encodeURIComponent(toValue(issue))}`, {
                method: 'PATCH', body,
            })
            return true
        } catch (error) {
            failed.value = errorMessage(error)
            return false
        } finally {
            saving.value = false
        }
    }
    return {save, saving, failed}
}
