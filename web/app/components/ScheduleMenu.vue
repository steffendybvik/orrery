<script setup lang="ts">
// Right-clicking a schedule: run it now (on top of its timetable, or instead of its next run, which it then
// skips), pause or resume it, edit or remove it, as the owner. The list updates live once a change is saved.
// Esc or a click outside closes it. A run stays on the page and confirms itself here (ORR-688), wherever it was run from,
// as this is always on the page.
const {menu, edit, ran, run} = useSchedules()

const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const close = () => menu.value = null

watch(menu, () => {
    failed.value = ''
    confirming.value = false
})

const s = computed(() => menu.value?.schedule)
const api = computed(() => s.value ? `/projects/${encodeURIComponent(s.value.project)}/schedules/${s.value.id}` : '')

async function send<T>(path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: Record<string, unknown>): Promise<T | undefined> {
    busy.value = true
    failed.value = ''
    try {
        const url: string = `${api.value}${path}`
        const data: unknown = await apiFetch<unknown>(url, {method, body})
        return data as T
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}

/** The next run that running it instead skips: its time, with its day when that isn't today, and in full. */
const skips = computed(() => {
    const next = s.value?.enabled && s.value.next_run
    if (!next) return null
    const full = when(next)
    const [day, time] = [full.replace(/ \d+:\d+$/, ''), full.replace(/^\w+ \d+ \w+ /, '')]
    return {full, short: day === when(new Date()).replace(/ \d+:\d+$/, '') ? time : `${day.split(' ')[0]} ${time}`}
})

async function runNow(instead = false) {
    if (!s.value) return
    busy.value = true
    failed.value = await run(s.value, instead) ?? ''
    busy.value = false
    if (!failed.value) close()
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
        <UiMenuItem v-if="s.kind !== 'action'" :disabled="busy" @click="runNow()">▶ Run now</UiMenuItem>
        <UiMenuItem v-if="skips" :disabled="busy" :title="`Runs it now and skips the run at ${skips.full}`" @click="runNow(true)">⏭ Run now instead of {{ skips.short }}</UiMenuItem>
        <UiMenuItem :disabled="busy" @click="toggle">{{ s.enabled ? '❙❙ Pause' : '▶ Resume' }}</UiMenuItem>
        <UiMenuItem @click="editIt">✎ Edit</UiMenuItem>
        <UiMenuItem danger :disabled="busy" @click="confirming = true">{{ s.across ? 'Leave this project out…' : 'Remove…' }}</UiMenuItem>
      </div>
      <UiConfirm v-else class="border-t border-line p-2" :busy="busy" @confirm="remove" @cancel="confirming = false">
        {{ s.across ? 'Leave this project out of it? The issues it made stay.' : 'Remove this schedule? The issues it made stay.' }}
      </UiConfirm>
      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    </template>
  </UiContextMenu>
  <Teleport to="body">
    <div role="status">
      <div v-if="ran" class="glass fixed bottom-4 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2 animate-fade-up rounded-full px-4 py-2 text-xs text-fg">
        <NuxtLink v-if="ran.issue" :to="`/p/${ran.project}/issues/${encodeURIComponent(ran.issue)}`" class="hover:underline">{{ ran.text }}</NuxtLink>
        <template v-else>{{ ran.text }}</template>
      </div>
    </div>
  </Teleport>
</template>
