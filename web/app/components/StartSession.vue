<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// The owner's Start session, for a project that lets Orrery start sessions: its launcher starts one in tmux,
// for the project's minutes, within its limit. Says why not when it can't (no launcher, the limit reached).
const props = defineProps<{project: Project}>()
const {load} = useOwner()
const busy = ref(false)
const failed = ref('')

// Whether a launcher is there and how many are running or on their way, asked again as those change.
const {state, refresh, install} = useLaunchState(() => props.project.id)

const full = computed(() => !!state.value && !!props.project.starts && state.value.started + state.value.starting >= props.project.starts.limit)
const why = computed(() => !state.value?.launchers ? `No launcher is running for ${props.project.name}: install one in its repo with ${install}`
    : full.value ? `${props.project.name} already has its ${props.project.starts!.limit} at once` : `Start a Claude session on ${props.project.name} for ${props.project.starts!.minutes} minutes`)

async function start() {
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project.id)}/launches`, {method: 'POST', headers: {'Orrery-Actor': await load()}})
        await refresh()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <div v-if="project.starts" class="flex shrink-0 flex-col items-end gap-1">
    <button
        type="button"
        class="h-7 rounded-md bg-accent-500 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        :disabled="busy || !state?.launchers || full"
        :title="why"
        @click="start"
    >
      {{ busy ? 'Starting…' : 'Start session' }}
    </button>
    <span v-if="state?.starting" class="text-xs text-faint">{{ state.starting }} on its way…</span>
    <span v-else-if="state && (!state.launchers || full)" class="max-w-72 text-right text-xs text-faint">
      <template v-if="!state.launchers">No launcher running: install it below.</template>
      <template v-else>At its limit of {{ project.starts!.limit }} at once.</template>
    </span>
    <span v-if="failed" class="max-w-64 text-right text-xs text-rose-600 dark:text-rose-400">{{ failed }}</span>
  </div>
</template>
