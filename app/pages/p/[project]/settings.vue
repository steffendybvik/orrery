<script setup lang="ts">
// A project's settings. For now its schedules: work Orrery starts on its own, each run making an issue
// in the project and, if set, asking its Claude sessions to pick it up.
const route = useRoute()
const {byId, ready} = useRoadmaps()
const {of, edit} = useSchedules()
const project = computed(() => byId(route.params.project as string))
useHead(() => ({title: project.value ? `Settings · ${project.value.name} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <ProjectTabs :project="project" />
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="project" class="mx-auto flex max-w-4xl animate-fade-up flex-col gap-4 px-4 py-8 sm:px-8">
      <section id="schedules" class="flex flex-col gap-3">
        <header class="flex items-start gap-3">
          <SectionIcon section="schedules" class="mt-0.5 size-4 text-accent-500" />
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 class="text-[15px] font-semibold text-fg">Schedules</h2>
            <p class="text-xs text-muted">Work Orrery starts on its own. Each run makes an issue in {{ project.name }}, and can ask its Claude sessions to pick it up.</p>
          </div>
          <button type="button" class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90" @click="edit(project.id)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New schedule
          </button>
        </header>
        <div class="overflow-hidden rounded-xl border border-line">
          <ScheduleList v-if="of(project.id).length" :schedules="of(project.id)" />
          <p v-else class="px-4 py-10 text-center text-sm text-muted">
            Nothing scheduled.
            <button type="button" class="text-accent-600 underline underline-offset-2 dark:text-accent-400" @click="edit(project.id)">Schedule something</button>
          </p>
        </div>
      </section>
    </div>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
