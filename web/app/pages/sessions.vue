<script setup lang="ts">
// Every project's Claude sessions in one place, by project, each opening on its project's Sessions tab; and
// Start session, which starts one on any project, focused on an issue if you pick one.
useHead({title: 'Sessions · Orrery'})
const {projects, ready, sessions} = useRoadmaps()
const {ordered} = useProjectOrder()
const {open} = useStartSession()

const groups = computed(() => ordered.value
    .map(project => ({project, sessions: sessions.value[project.id] ?? []}))
    .filter(g => g.sessions.length))
</script>

<template>
  <PageHeader>
    <SectionIcon section="sessions" class="size-4 shrink-0 text-accent-500" />
    <h1 class="truncate text-sm font-medium">Sessions across projects</h1>
    <button type="button" class="ml-auto h-7 shrink-0 rounded-md bg-accent-500 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90" @click="open()">Start session</button>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <p v-else-if="ready && !groups.length" class="px-4 py-10 text-center text-sm text-faint">No Claude sessions right now. Start one, or open Claude in a connected repo.</p>
    <section v-for="group in groups" :key="group.project.id">
      <NuxtLink :to="`/p/${group.project.id}/sessions`" class="sticky top-0 z-10 flex h-9 items-center gap-2.5 border-b border-line bg-panel/90 px-3 backdrop-blur hover:bg-hover">
        <ProjectIcon v-if="group.project.icon && heroicon(group.project.icon)" :icon="group.project.icon" :color="group.project.icon_color" class="size-3.5" />
        <h2 class="text-[13px] font-medium">{{ group.project.name }}</h2>
        <span class="font-mono text-[11px] text-faint">{{ group.sessions.length }}</span>
      </NuxtLink>
      <NuxtLink
          v-for="session in group.sessions"
          :key="session.id"
          :to="`/p/${group.project.id}/sessions#session-${session.id}`"
          class="flex h-10 items-center gap-2.5 border-b border-line px-4 text-[13px] text-fg hover:bg-hover"
      >
        <SessionDot :session="session" />
        <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
        <span v-if="session.started" class="shrink-0 text-xs text-faint">started by Orrery</span>
        <span class="w-20 shrink-0 text-right text-xs" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">{{ SESSION_STATE[session.state] }}</span>
      </NuxtLink>
    </section>
  </div>
</template>
