<script setup lang="ts">
import type {Preset, Schedule} from '#shared/roadmap'
import type {ScheduleSuggestion} from '#shared/schedule-suggestions'
import {SCHEDULE_SUGGESTIONS} from '#shared/schedule-suggestions'

// On Schedules: ready-made schedules (ORR-344, ORR-629), for the project the page keeps to, else the first. Add opens New
// schedule filled in, to check and save; none runs until then. One the project already has (the same kind on the same
// event, or for one on a clock the same kind and title) goes from the list. Review only shows while the orrery has an
// In review status, one that moves issues while the orrery has the statuses it names, and Review GitHub issues while the
// project's repo is on GitHub.
const props = defineProps<{project: string, schedules: Schedule[]}>()
const {edit} = useSchedules()
const {byId} = useRoadmaps()
const {places} = useStatuses()

// The presets its sessions can have, to find the shipped ones by key.
const presets = ref<Preset[]>([])
watch(() => props.project, async id => {
    presets.value = id ? await apiFetch<Preset[]>(`/projects/${encodeURIComponent(id)}/presets`).catch(() => []) : []
}, {immediate: true})
const shipped = (s: ScheduleSuggestion) => s.presets.flatMap(key => presets.value.filter(p => p.default?.key === key && !p.project))

// The project's repo on GitHub, `https://github.com/you/shop`, when it's there.
const github = computed(() => byId(props.project)?.repo?.trim().match(/^https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+?(?=(?:\.git)?\/?$)/i)?.[0])

const offered = computed(() => SCHEDULE_SUGGESTIONS.filter(s =>
    !props.schedules.some(made => made.kind === s.kind && (s.on ? made.on === s.on : made.title === s.title))
    && (!s.on_filter?.to || places.value.some(p => p.id === s.on_filter?.to))
    && [...s.column ? [s.column] : [], ...s.move_from ?? []].every(id => places.value.some(p => p.id === id))
    && (!s.github || github.value)))

function add(s: ScheduleSuggestion) {
    edit(props.project, undefined, {
        kind: s.kind, title: s.title, notes: (s.notes ?? '').replaceAll('{github}', github.value ?? ''),
        ...s.on ? {on: s.on} : {}, ...s.on_filter ? {on_filter: s.on_filter} : {}, ...s.cron ? {cron: s.cron} : {},
        presets: shipped(s).map(p => p.id),
        ...s.column ? {column: s.column} : {}, ...s.move_from ? {move_from: s.move_from} : {}, ...s.paused ? {enabled: false} : {},
    })
}
</script>

<template>
  <section v-if="offered.length" class="flex flex-col overflow-hidden rounded-2xl ring-1 ring-line">
    <header class="flex flex-col gap-0.5 border-b border-line bg-well/60 px-4 py-2.5">
      <h2 class="text-[14px] font-semibold">Suggested for {{ byId(project)?.name ?? project }}</h2>
      <p class="text-xs text-muted">Ready-made schedules, most for the presets orrery ships. Add opens one filled in; nothing runs until you save it.</p>
    </header>
    <div v-for="s in offered" :key="s.key" class="flex items-center gap-3 border-b border-line/60 px-4 py-3 text-sm last:border-b-0">
      <span class="flex w-9 shrink-0 justify-center -space-x-1.5">
        <PresetBadge v-for="p in shipped(s)" :key="p.id" :preset="p" :size="24" />
        <span v-if="!shipped(s).length && s.kind === 'issue'" class="grid size-6 place-items-center rounded-md text-accent-600 ring-1 ring-inset ring-line dark:text-accent-400">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><circle cx="12" cy="12" r="8" /></svg>
        </span>
        <span v-else-if="!shipped(s).length && s.kind === 'action'" class="grid size-6 place-items-center rounded-md text-amber-600 ring-1 ring-inset ring-line dark:text-amber-400">→</span>
        <span v-else-if="!shipped(s).length" class="grid size-6 place-items-center rounded-md text-sky-600 ring-1 ring-inset ring-line dark:text-sky-400">✉</span>
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 sm:flex-nowrap">
          <span class="max-w-full truncate font-medium text-fg">{{ s.title }}</span>
          <span
              class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium"
              :class="s.kind === 'message' ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300' : s.kind === 'session' ? 'bg-violet-500/12 text-violet-700 dark:text-violet-300' : s.kind === 'action' ? 'bg-amber-500/12 text-amber-700 dark:text-amber-300' : 'bg-accent-500/12 text-accent-700 dark:text-accent-300'"
          >{{ s.kind === 'message' ? 'Messages sessions' : s.kind === 'session' ? 'Starts a session' : s.kind === 'action' ? 'Moves issues' : 'Makes an issue' }}</span>
        </div>
        <span class="truncate text-xs text-faint">{{ s.when }}<template v-if="shipped(s).length"> · {{ shipped(s).map(p => p.name).join(' + ') }}</template></span>
      </div>
      <UiButton class="shrink-0" :aria-label="`Add ${s.title}`" @click="add(s)">Add</UiButton>
    </div>
  </section>
</template>
