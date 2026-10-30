<script setup lang="ts">
import {BoltIcon} from '@heroicons/vue/16/solid'
// Every project's schedules, a card for each project that has any (ScheduleList), in the sidebar's order;
// `?project=` keeps to one (a project's old Schedules tab comes here that way), shown even with none. New schedule
// opens the dialog on the project kept to, else the first, and the project is picked there; a card's own makes one on it.
// Under them, schedules suggested for that same project (ScheduleSuggestions), ready to add. Above them, the schedules
// across projects (ORR-638), those that reach the project kept to.
const route = useRoute()
const router = useRouter()
const {projects, ready, byId} = useRoadmaps()
const {ordered} = useProjectOrder()
const {byProject, edit, across, editAcross} = useSchedules()
const acrossHere = computed(() => across.value.filter(a => !only.value || a.on_projects.includes(only.value)))
/** Which projects one is for, in words. */
function reach(a: typeof across.value[number]): string {
    const name = (id: string) => byId(id)?.name ?? id
    if (a.projects !== '*') return a.projects.map(name).join(', ')
    return a.skip.length ? `All projects, not ${a.skip.map(name).join(', ')}` : 'All projects'
}
const only = computed({
    get: () => (route.query.project as string | undefined) ?? '',
    set: id => router.replace({query: id ? {project: id} : {}}),
})
// Kept to one project, the tab says which, as its other tabs do.
useHead(() => ({title: ['Schedules', byId(only.value)?.name, 'orrery'].filter(Boolean).join(' · ')}))
const all = computed(() => Object.values(byProject.value).flat().filter(s => !only.value || s.project === only.value))
const cards = computed(() => ordered.value
    .map(project => ({project, schedules: byProject.value[project.id] ?? []}))
    .filter(c => only.value ? c.project.id === only.value : c.schedules.length))
const active = computed(() => all.value.filter(s => s.enabled).length)
const projectOptions = computed(() => [{value: '', label: 'All projects'}, ...ordered.value.map(p => ({value: p.id, label: p.name}))])

const target = computed(() => only.value || ordered.value[0]?.id || '')

function newSchedule() {
    if (target.value) edit(target.value)
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="schedules" class="size-4 shrink-0 text-accent-500" />
    <h1 class="truncate text-sm font-medium">Schedules</h1>
  </PageHeader>

  <ViewToolbar>
    <PropertyPicker v-model="only" :options="projectOptions" label="Project" field small>
      <span class="truncate">{{ projectOptions.find(o => o.value === only)?.label ?? only }}</span>
    </PropertyPicker>
    <span class="text-xs text-muted">{{ all.length ? `${active} running, ${all.length - active} paused` : 'Nothing scheduled' }}</span>
    <template v-if="ordered.length && !only" #end>
      <UiButton variant="primary" class="shrink-0" @click="newSchedule">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        New schedule
      </UiButton>
    </template>
  </ViewToolbar>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <div v-else-if="cards.length || acrossHere.length" class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <section v-if="acrossHere.length" class="flex flex-col overflow-hidden rounded-xl border border-line bg-panel" aria-label="Across projects">
        <header class="border-b border-line bg-well/60 px-4 py-2.5"><h2 class="text-[14px] font-semibold">Across projects</h2></header>
        <button
            v-for="a in acrossHere"
            :key="a.id"
            type="button"
            class="flex flex-col gap-0.5 border-b border-line/60 px-4 py-3 text-left text-sm last:border-b-0 hover:bg-hover"
            :class="a.enabled === false && 'opacity-60'"
            @click="editAcross(a)"
        >
          <span class="truncate font-medium text-fg">{{ a.title }}</span>
          <span class="truncate text-xs text-faint"><BoltIcon v-if="a.on" class="mr-0.5 inline size-3 align-[-2px] text-teal-600 dark:text-teal-400" aria-hidden="true" />{{ reach(a) }} · {{ a.on ? describe({on: a.on, on_filter: a.on_filter, timezone: a.timezone ?? localZone()}) : describe({cron: a.cron, timezone: a.timezone ?? localZone()}) }}<template v-if="a.enabled === false"> · paused</template></span>
        </button>
      </section>
      <ScheduleList v-for="card in cards" :key="card.project.id" :project="card.project" :schedules="card.schedules" />
      <ScheduleSuggestions v-if="target" :project="target" :schedules="byProject[target] ?? []" />
    </div>
    <div v-else-if="ready" class="mx-auto flex max-w-4xl flex-col px-4 py-6">
      <p class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        Nothing scheduled on any project yet.
        <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="newSchedule">Make one</button>
        to message sessions, start one, or make an issue, at a set time or when something happens.
      </p>
      <ScheduleSuggestions v-if="target" class="mt-4" :project="target" :schedules="byProject[target] ?? []" />
    </div>
  </div>
</template>
