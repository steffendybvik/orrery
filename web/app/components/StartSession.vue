<script setup lang="ts">
import type {Project} from '#shared/roadmap'
import {startsFor} from '#shared/roadmap'

// The owner's Start session, once Orrery may start sessions: opens Start session on it, where it can
// be given an issue, a scope and context; its launcher starts one in tmux, for the minutes that apply or until stopped, within its
// limit. Says why not when it can't (no launcher, the limit reached).
const props = defineProps<{project: Project}>()
const {open} = useStartSession()

// Whether a launcher is there and how many are running or on their way, asked again as those change.
const {state, install} = useLaunchState(() => props.project.id)
const {settings} = useAppSettings()
/** Its limits: its own, or the Orrery's; none while Orrery doesn't start sessions. */
const starts = computed(() => startsFor(props.project, settings.value))

const full = computed(() => !!state.value && !!starts.value && state.value.started + state.value.starting >= starts.value.limit)
const why = computed(() => !state.value?.launchers ? `No launcher is running for ${props.project.name}: install one in its repo with ${install}`
    : full.value ? `${props.project.name} already has its ${starts.value!.limit} at once` : `Start a Claude session on ${props.project.name} ${starts.value!.minutes ? `for ${starts.value!.minutes} minutes` : 'until you stop it'}`)
</script>

<template>
  <div v-if="starts" class="flex shrink-0 flex-col items-end gap-1">
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
      <template v-else>At its limit of {{ starts.limit }} at once.</template>
    </span>
  </div>
</template>
