<script setup lang="ts">
import type {Project} from '#shared/roadmap'

// The owner's Start session for a project, once Orrery may start sessions: opens Start session on it, where it can
// be given an issue, a scope and context; its launcher starts one in tmux, for the project's minutes or until stopped, within its
// limit over every project. Says why not when it can't (no launcher, the limit reached).
const props = defineProps<{project: Project}>()
const {open} = useStartSession()

// Whether a launcher is there and how many are running or on their way, asked again as those change.
const {state, install} = useLaunchState(() => props.project.id)

const full = computed(() => !!state.value && !!props.project.starts && state.value.total >= props.project.starts.limit)
const why = computed(() => {
    const {name, starts} = props.project
    if (!state.value?.launchers) return `No launcher is running for ${name}: install one in its repo with ${install}`
    if (starts && full.value) return `Orrery already has its ${starts.limit} at once`
    return `Start a Claude session on ${name} ${starts?.minutes ? `for ${starts.minutes} minutes` : 'until you stop it'}`
})
</script>

<template>
  <div v-if="project.starts" class="flex shrink-0 flex-col items-end gap-1">
    <UiButton
        variant="primary"
        :disabled="!state?.launchers || full"
        :title="why"
        @click="open(project.id)"
    >
      Start session…
    </UiButton>
    <span v-if="state?.starting" class="text-xs text-faint">{{ state.starting }} on its way…</span>
    <span v-else-if="state && (!state.launchers || full)" class="max-w-72 text-right text-xs text-faint">
      <template v-if="!state.launchers">No launcher running: install it in its repo.</template>
      <template v-else>At the limit of {{ project.starts!.limit }} at once.</template>
    </span>
  </div>
</template>
