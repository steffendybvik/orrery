<script setup lang="ts">
import type {Project, Starts} from '#shared/roadmap'
import {startsFor} from '#shared/roadmap'

// Whether Orrery may start Claude sessions itself, with no terminal, and within what: how many at once, and, if
// the owner likes, how long each runs and how long one may sit idle (blank runs it until stopped). Without a
// project, on App settings, it's the owner's opt-in, once, for every project. With one, on its Sessions page, it's
// the project's own limits, or the Orrery's, and whether its launcher is there.
const props = defineProps<{project?: Project}>()
const {load} = useOwner()
const {settings, save: saveSettings} = useAppSettings()
// Whether a launcher is there to start them, asked again as its launchers or sessions change.
const {state} = useLaunchState(() => props.project?.id ?? '')
const failed = ref('')
const field = 'h-8 w-20 rounded-lg bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none'

/** The limits shown: the project's that apply, or the Orrery's. */
const shown = computed(() => props.project ? startsFor(props.project, settings.value) : settings.value.starts ?? undefined)
const on = computed(() => !!settings.value.starts)
const own = computed(() => !!props.project?.starts)

const limit = ref(1)
// Blank (an empty input gives '') is no limit.
const minutes = ref<number | ''>('')
const idleMinutes = ref<number | ''>('')
watch(shown, starts => {
    limit.value = starts?.limit ?? 1
    minutes.value = starts?.minutes ?? ''
    idleMinutes.value = starts?.idle_minutes ?? ''
}, {immediate: true})

async function save(starts: Starts | null) {
    failed.value = ''
    try {
        if (props.project) {
            await $fetch(`/api/projects/${encodeURIComponent(props.project.id)}`, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: {starts}})
        } else {
            await saveSettings({starts})
        }
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

const limits = () => ({limit: limit.value, minutes: minutes.value || undefined, idle_minutes: idleMinutes.value || undefined})
</script>

<template>
  <div class="flex flex-col gap-2 rounded-xl border border-line p-3 text-[13px]">
    <label v-if="!project" class="flex items-center gap-2 text-fg">
      <input type="checkbox" class="accent-accent-500" :checked="on" @change="save(($event.target as HTMLInputElement).checked ? limits() : null)">
      Let Orrery start Claude sessions
    </label>
    <p v-else-if="!on" class="text-muted">
      Orrery doesn't start sessions yet.
      <NuxtLink to="/settings#starts" class="text-accent-600 underline underline-offset-2 dark:text-accent-400">Turn it on</NuxtLink>
      once, for every project, in App settings.
    </p>
    <p v-else class="flex flex-wrap items-center gap-x-2 text-fg">
      {{ own ? `${project.name}'s own limits` : `The Orrery's limits, for ${project.name} too` }}
      <button v-if="own" type="button" class="text-xs text-accent-600 hover:underline dark:text-accent-400" @click="save(null)">Use the Orrery's</button>
    </p>
    <template v-if="!project || on">
      <div class="flex flex-wrap items-center gap-2 text-xs text-muted" :class="{'opacity-50': !on}">
        <span>At most</span>
        <input v-model.number="limit" type="number" min="1" max="20" aria-label="Sessions at once" :class="field" :disabled="!on" @change="save(limits())">
        <span>at once{{ project ? '' : ' on a project' }}. Stop each after</span>
        <input v-model.number="minutes" type="number" min="1" max="1440" placeholder="never" aria-label="Minutes each" :class="field" :disabled="!on" @change="save(limits())">
        <span>minutes, or once idle for</span>
        <input v-model.number="idleMinutes" type="number" min="1" max="1440" placeholder="never" aria-label="Idle minutes" :class="field" :disabled="!on" @change="save(limits())">
        <span>minutes.</span>
      </div>
      <p class="text-xs text-faint" :class="{'opacity-50': !on}">
        Left blank, a session runs until you stop it. Neither stops one mid-work: it waits until the session is idle with nothing in progress.
        <template v-if="!project">A project can have limits of its own, on its Sessions tab.</template>
        <template v-else-if="!own">Changing them gives {{ project.name }} its own.</template>
      </p>
    </template>
    <p v-if="project && state" class="text-xs text-faint">
      <template v-if="state.launchers">Its launcher is running{{ state.started ? `, with ${state.started} session${state.started === 1 ? '' : 's'} it started` : '' }}.</template>
      <template v-else>No launcher is running for it yet: install it as step 2 below says.</template>
    </p>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
