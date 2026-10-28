<script setup lang="ts">
import type {Preset, Schedule} from '#shared/roadmap'
import type {ScheduleSuggestion} from '#shared/schedule-suggestions'
import {SCHEDULE_SUGGESTIONS} from '#shared/schedule-suggestions'

// On Schedules: ready-made event schedules for the presets Orrery ships (ORR-344), for the project the page keeps to, else
// the first. Add opens New schedule filled in, to check and save; none runs until then. One the project already has (the
// same kind on the same event) goes from the list, and Review only shows while the Orrery has an In review status.
const props = defineProps<{project: string, schedules: Schedule[]}>()
const {edit} = useSchedules()
const {byId} = useRoadmaps()
const {places} = useStatuses()

// The presets its sessions can have, to find the shipped ones by key.
const presets = ref<Preset[]>([])
watch(() => props.project, async id => {
    presets.value = id ? await $fetch<Preset[]>(`/api/projects/${encodeURIComponent(id)}/presets`).catch(() => []) : []
}, {immediate: true})
const shipped = (s: ScheduleSuggestion) => s.presets.flatMap(key => presets.value.filter(p => p.default?.key === key && !p.project))

const offered = computed(() => SCHEDULE_SUGGESTIONS.filter(s =>
    !props.schedules.some(made => made.kind === s.kind && made.on === s.on)
    && (!s.on_filter?.to || places.value.some(p => p.id === s.on_filter?.to))))

function add(s: ScheduleSuggestion) {
    edit(props.project, undefined, {
        kind: s.kind, title: s.title, notes: s.notes ?? '', on: s.on, ...s.on_filter ? {on_filter: s.on_filter} : {},
        presets: shipped(s).map(p => p.id),
    })
}
</script>

<template>
  <section v-if="offered.length" class="flex flex-col overflow-hidden rounded-2xl ring-1 ring-line">
    <header class="flex flex-col gap-0.5 border-b border-line bg-well/60 px-4 py-2.5">
      <h2 class="text-[14px] font-semibold">Suggested for {{ byId(project)?.name ?? project }}</h2>
      <p class="text-xs text-muted">Ready-made schedules for the presets Orrery ships. Add opens one filled in; nothing runs until you save it.</p>
    </header>
    <div v-for="s in offered" :key="s.key" class="flex items-center gap-3 border-b border-line/60 px-4 py-3 text-sm last:border-b-0">
      <span class="flex w-9 shrink-0 justify-center -space-x-1.5">
        <PresetBadge v-for="p in shipped(s)" :key="p.id" :preset="p" :size="24" />
        <span v-if="!shipped(s).length" class="grid size-6 place-items-center rounded-md text-sky-600 ring-1 ring-inset ring-line dark:text-sky-400">✉</span>
      </span>
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex min-w-0 items-center gap-2">
          <span class="truncate font-medium text-fg">{{ s.title }}</span>
          <span
              class="shrink-0 rounded-full px-1.5 py-px text-[10px] font-medium"
              :class="s.kind === 'message' ? 'bg-sky-500/12 text-sky-700 dark:text-sky-300' : 'bg-violet-500/12 text-violet-700 dark:text-violet-300'"
          >{{ s.kind === 'message' ? 'Messages sessions' : 'Starts a session' }}</span>
        </div>
        <span class="truncate text-xs text-faint">{{ s.when }}<template v-if="shipped(s).length"> · {{ shipped(s).map(p => p.name).join(' + ') }}</template></span>
      </div>
      <UiButton class="shrink-0" :aria-label="`Add ${s.title}`" @click="add(s)">Add</UiButton>
    </div>
  </section>
</template>
