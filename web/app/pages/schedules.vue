<script setup lang="ts">
// Every project's schedules in one agenda, soonest first, each saying its project; a new one is made on the
// project picked for it. A project's own are on its Schedules tab too.
useHead({title: 'Schedules · Orrery'})
const {projects, ready} = useRoadmaps()
const {ordered} = useProjectOrder()
const {byProject, edit} = useSchedules()
const all = computed(() => Object.values(byProject.value).flat().sort((a, b) => (a.next_run ?? '~').localeCompare(b.next_run ?? '~')))

/** The project a new schedule goes on, picked from the select; it opens the dialog and resets. */
const picked = computed({
    get: () => '',
    set: (project: string) => project && edit(project),
})
</script>

<template>
  <PageHeader>
    <SectionIcon section="schedules" class="size-4 shrink-0 text-accent-500" />
    <h1 class="truncate text-sm font-medium">Schedules</h1>
    <template v-if="ordered.length" #actions>
      <select v-model="picked" aria-label="New schedule in" class="h-7 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none">
        <option value="" disabled>+ New schedule in…</option>
        <option v-for="p in ordered" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <ScheduleList v-else-if="all.length" :schedules="all" projects />
    <p v-else-if="ready" class="px-4 py-10 text-center text-sm text-faint">Nothing scheduled on any project. Work Orrery starts on its own goes here.</p>
  </div>
</template>
