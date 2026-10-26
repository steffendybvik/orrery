<script setup lang="ts">
// Right-clicking a schedule: run it now, pause or resume it, edit or remove it, as the owner. The list
// updates live once a change is saved. Esc or a click outside closes it.
const {menu, edit} = useSchedules()
const {load} = useOwner()
const {open: openIssue} = useIssueLink()

const box = ref<HTMLElement | null>(null)
const place = ref({left: 0, top: 0})
const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const close = () => menu.value = null

watch(menu, now => {
    failed.value = ''
    confirming.value = false
    if (!now) return
    place.value = {left: now.x, top: now.y}
    nextTick(() => {
        const rect = box.value?.getBoundingClientRect()
        if (!rect) return
        place.value = {
            left: Math.max(8, Math.min(now.x, window.innerWidth - rect.width - 8)),
            top: Math.max(8, Math.min(now.y, window.innerHeight - rect.height - 8)),
        }
        box.value?.focus()
    })
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

function onOutside(event: PointerEvent) {
    if (!box.value?.contains(event.target as Node)) close()
}
watch(() => !!menu.value, isOpen => {
    if (isOpen) {
        document.addEventListener('pointerdown', onOutside, true)
        window.addEventListener('blur', close)
    } else {
        document.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('blur', close)
    }
})
onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('blur', close)
})

</script>

<template>
  <Teleport to="body">
    <div
        v-if="menu && s"
        ref="box"
        class="menu fixed z-50 w-60"
        :style="{left: `${place.left}px`, top: `${place.top}px`}"
        role="menu"
        :aria-label="`Actions for ${s.title}`"
        tabindex="-1"
        @keydown.esc.stop="close"
        @contextmenu.prevent
    >
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
    </div>
  </Teleport>
</template>
