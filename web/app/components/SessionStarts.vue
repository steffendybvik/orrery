<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// Whether Orrery may start Claude sessions itself, with no terminal: with `project`, the owner's opt-in for it
// (how many at once, how long each runs) and whether its launcher is there; on App settings, the limit over
// every project.
const props = defineProps<{project?: Project}>()
const {settings, save: saveSettings} = useAppSettings()
const {load} = useOwner()
const failed = ref('')
const field = 'h-8 w-20 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'

const limit = ref(1)
const minutes = ref(60)
const total = ref(3)
watch(() => [props.project?.starts, settings.value.sessionLimit] as const, ([starts, all]) => {
    limit.value = starts?.limit ?? 1
    minutes.value = starts?.minutes ?? 60
    total.value = all
}, {immediate: true})

// Whether a launcher is there to start them, asked again as the project changes.
const state = ref<{launchers: number, started: number, starting: number} | null>(null)
async function refresh() {
    if (!props.project) return
    state.value = await $fetch<typeof state.value>(`/api/projects/${encodeURIComponent(props.project.id)}/launches`).catch(() => null)
}
watch(() => props.project, refresh, {immediate: true})

async function save(change: Record<string, unknown>) {
    failed.value = ''
    try {
        if (props.project) {
            await $fetch(`/api/projects/${encodeURIComponent(props.project.id)}`, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: change})
        } else {
            await saveSettings(change)
        }
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

function saveStarts(on = !!props.project?.starts) {
    save({starts: on ? {limit: limit.value, minutes: minutes.value} : null})
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]">
    <template v-if="project">
      <label class="flex items-center gap-2 text-fg">
        <input type="checkbox" class="accent-accent-500" :checked="!!project.starts" @change="saveStarts(($event.target as HTMLInputElement).checked)">
        Let Orrery start sessions for {{ project.name }}
      </label>
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted" :class="{'opacity-50': !project.starts}">
        <span>At most</span>
        <input v-model.number="limit" type="number" min="1" max="20" aria-label="Sessions at once" :class="field" :disabled="!project.starts" @change="saveStarts()">
        <span>at once, each stopped after</span>
        <input v-model.number="minutes" type="number" min="1" max="1440" aria-label="Minutes each" :class="field" :disabled="!project.starts" @change="saveStarts()">
        <span>minutes.</span>
      </div>
      <p v-if="state" class="text-xs text-faint">
        <template v-if="state.launchers">Its launcher is running{{ state.started ? `, with ${state.started} session${state.started === 1 ? '' : 's'} it started` : '' }}.</template>
        <template v-else>No launcher is running for it: start one in its repo with <span class="font-mono">ORRERY_PROJECT={{ project.id }} node channel/orrery-launcher.mjs</span>.</template>
      </p>
    </template>
    <div v-else class="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>At most</span>
      <input v-model.number="total" type="number" min="0" max="50" aria-label="Started sessions at once, over every project" :class="field" @change="save({sessionLimit: total})">
      <span>sessions Orrery started running at once, over every project.</span>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
