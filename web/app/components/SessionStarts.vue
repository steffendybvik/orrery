<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// Whether Orrery may start Claude sessions for the project itself, with no terminal: the owner's opt-in (how
// many at once, and, if they like, how long each runs and how long one may sit idle; blank runs it until stopped)
// and whether its launcher is there. On the Sessions page, whose list has the sessions it started.
const props = defineProps<{project: Project}>()
const {load} = useOwner()
// Whether a launcher is there to start them, asked again as its launchers or sessions change.
const {state} = useLaunchState(() => props.project.id)
const failed = ref('')
const field = 'h-8 w-20 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'

const limit = ref(1)
// Blank (an empty input gives '') is no limit.
const minutes = ref<number | ''>('')
const idleMinutes = ref<number | ''>('')
watch(() => props.project.starts, starts => {
    limit.value = starts?.limit ?? 1
    minutes.value = starts?.minutes ?? ''
    idleMinutes.value = starts?.idle_minutes ?? ''
}, {immediate: true})

async function save(change: Record<string, unknown>) {
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project.id)}`, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: change})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

function saveStarts(on = !!props.project.starts) {
    save({starts: on ? {limit: limit.value, minutes: minutes.value || null, idle_minutes: idleMinutes.value || null} : null})
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]">
    <label class="flex items-center gap-2 text-fg">
      <input type="checkbox" class="accent-accent-500" :checked="!!project.starts" @change="saveStarts(($event.target as HTMLInputElement).checked)">
      Let Orrery start sessions for {{ project.name }}
    </label>
    <div class="flex flex-wrap items-center gap-2 text-xs text-muted" :class="{'opacity-50': !project.starts}">
      <span>At most</span>
      <input v-model.number="limit" type="number" min="1" max="20" aria-label="Sessions at once" :class="field" :disabled="!project.starts" @change="saveStarts()">
      <span>at once. Stop each after</span>
      <input v-model.number="minutes" type="number" min="1" max="1440" placeholder="never" aria-label="Minutes each" :class="field" :disabled="!project.starts" @change="saveStarts()">
      <span>minutes, or once idle for</span>
      <input v-model.number="idleMinutes" type="number" min="1" max="1440" placeholder="never" aria-label="Idle minutes" :class="field" :disabled="!project.starts" @change="saveStarts()">
      <span>minutes.</span>
    </div>
    <p class="text-xs text-faint" :class="{'opacity-50': !project.starts}">
      Left blank, a session runs until you stop it. Neither stops one mid-work: it waits until the session is idle with nothing in progress.
    </p>
    <p v-if="state" class="text-xs text-faint">
      <template v-if="state.launchers">Its launcher is running{{ state.started ? `, with ${state.started} session${state.started === 1 ? '' : 's'} it started` : '' }}.</template>
      <template v-else>No launcher is running for it yet: install it as step 2 below says.</template>
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
