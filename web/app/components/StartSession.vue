<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// The owner's Start session, for a project that lets Orrery start sessions: opens Start session on it, where it can
// be given an issue, a scope and context; its launcher starts one in tmux, for the project's minutes, within its
// limit. Says why not when it can't (no launcher, the limit reached).
const props = defineProps<{project: Project}>()
const {open} = useStartSession()

// Whether a launcher is there and how many are running or on their way, asked again as those change.
const {state, install} = useLaunchState(() => props.project.id)

const full = computed(() => !!state.value && !!props.project.starts && state.value.started + state.value.starting >= props.project.starts.limit)
const why = computed(() => !state.value?.launchers ? `No launcher is running for ${props.project.name}: install one in its repo with ${install}`
    : full.value ? `${props.project.name} already has its ${props.project.starts!.limit} at once` : `Start a Claude session on ${props.project.name} for ${props.project.starts!.minutes} minutes`)
</script>

<template>
  <div v-if="project.starts" class="flex shrink-0 flex-col items-end gap-1">
    <button
        type="button"
        class="h-7 rounded-md bg-accent-500 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
        :disabled="!state?.launchers || full"
        :title="why"
        @click="open(project.id)"
    >
      Start session…
    </button>
    <span v-if="state?.starting" class="text-xs text-faint">{{ state.starting }} on its way…</span>
    <span v-else-if="state && (!state.launchers || full)" class="max-w-72 text-right text-xs text-faint">
      <template v-if="!state.launchers">No launcher running: install it below.</template>
      <template v-else>At its limit of {{ project.starts!.limit }} at once.</template>
    </span>
  </div>
</template>
