<script setup lang="ts">
// Right-clicking a schedule: run it now, pause or resume it, edit or remove it, as the owner. The list
// updates live once a change is saved. Esc or a click outside closes it.
const {menu, edit} = useSchedules()
const {load} = useOwner()
const {open: openIssue} = useIssueLink()

const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const close = () => menu.value = null

watch(menu, () => {
    failed.value = ''
    confirming.value = false
})

const s = computed(() => menu.value?.schedule)
const api = computed(() => s.value ? `/api/projects/${encodeURIComponent(s.value.project)}/schedules/${s.value.id}` : '')

async function send<T>(path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<T | undefined> {
    busy.value = true
    failed.value = ''
    try {
        const url: string = `${api.value}${path}`
        const data: unknown = await $fetch<unknown>(url, {method, headers: {'Orrery-Actor': await load()}, body})
        return data as T
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}

async function runNow() {
    const schedule = s.value
    const run = await send<{issue?: string}>('/run', 'POST')
    if (!run || !schedule) return
    close()
    if (run.issue) openIssue(schedule.project, run.issue)
}
async function toggle() {
    if (await send('', 'PATCH', {enabled: !s.value?.enabled}) !== undefined) close()
}
async function remove() {
    if (await send('', 'DELETE') !== undefined || !failed.value) close()
}
function editIt() {
    if (s.value) edit(s.value.project, s.value)
    close()
}


</script>

<template>
  <UiContextMenu :at="s ? menu : null" :label="`Actions for ${s?.title}`" width="w-60" @close="close">
    <template v-if="s">
      <div class="truncate px-2 pt-1.5 pb-1 text-xs text-muted">{{ s.title }}</div>
      <div v-if="!confirming" class="flex flex-col border-t border-line pt-1">
        <UiMenuItem :disabled="busy" @click="runNow">▶ Run now</UiMenuItem>
        <UiMenuItem :disabled="busy" @click="toggle">{{ s.enabled ? '❙❙ Pause' : '▶ Resume' }}</UiMenuItem>
        <UiMenuItem @click="editIt">✎ Edit</UiMenuItem>
        <UiMenuItem danger :disabled="busy" @click="confirming = true">Remove…</UiMenuItem>
      </div>
      <UiConfirm v-else class="border-t border-line p-2" :busy="busy" @confirm="remove" @cancel="confirming = false">
        Remove this schedule? The issues it made stay.
      </UiConfirm>
      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    </template>
  </UiContextMenu>
</template>
