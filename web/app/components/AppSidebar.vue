<script setup lang="ts">
import type {Issue} from '#shared/roadmap'

// Every project with its progress and how many issues are started; Now across projects on top.
const {projects, ready, live} = useRoadmaps()
const route = useRoute()
const {of: schedulesOf} = useSchedules()
const open = useState('sidebar-open', () => false)
const palette = useState('palette-open', () => false)
const {environment} = useRuntimeConfig().public
const newProject = useState('new-project', () => false)

watch(() => route.fullPath, () => {
    open.value = false
})

/** Top-level issues on the Now page. */
const nowCount = computed(() => projects.value.reduce((sum, p) =>
    sum + p.board.chunks.reduce((n, c) => n + c.tasks.filter((t: Issue) => isNow(t)).length, 0), 0))
const urgentCount = computed(() => projects.value.reduce((sum, p) => sum + urgentIssues(p).length, 0))
const {name: owner, load: loadOwner} = useOwner()
const {unseenIn} = useUnseen()
onMounted(loadOwner)
const mineCount = computed(() => projects.value.reduce((sum, p) => sum + myIssues(p, owner.value).length, 0))
const LIVE = {live: 'Live', connecting: 'Connecting…', offline: 'Offline'}

// Projects are dragged by their name to rearrange them (or moved with ⌥↑/⌥↓); a line shows where one lands.
const {ordered, move} = useProjectOrder()
const {sessions} = useRoadmaps()
const SESSION_STATE = {idle: 'idle', working: 'working', waiting: 'needs you', starting: 'starting'}
const dragging = ref<string | null>(null)
const dropAt = ref<number | null>(null)

function onDragOver(event: DragEvent, index: number) {
    if (!dragging.value) return
    event.preventDefault()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropAt.value = event.clientY < box.top + box.height / 2 ? index : index + 1
}

function onDrop() {
    if (dragging.value === null || dropAt.value === null) return
    const from = ordered.value.findIndex(p => p.id === dragging.value)
    move(dragging.value, dropAt.value > from ? dropAt.value - 1 : dropAt.value)
    onDragEnd()
}

function onDragEnd() {
    dragging.value = null
    dropAt.value = null
}

// A project's pages fold away under it (→ / ← on its name), so a long list stays short.
const {isOpen, set: setFolds, toggle} = useProjectFolds()
const allOpen = computed(() => ordered.value.length > 0 && ordered.value.every(p => isOpen(p.id)))

// Every Claude session, at the bottom: the ones waiting on you first, then by project as arranged.
const allSessions = computed(() => ordered.value
    .flatMap(project => (sessions.value[project.id] ?? []).map(session => ({session, project})))
    .sort((a, b) => Number(b.session.state === 'waiting') - Number(a.session.state === 'waiting')))

function nudge(id: string, by: number, event: KeyboardEvent) {
    const from = ordered.value.findIndex(p => p.id === id)
    move(id, from + by)
    nextTick(() => (event.target as HTMLElement).focus())
}

</script>

<template>
  <!-- On a phone it's a drawer over the whole screen (the menu button in PageHeader), with bigger rows to tap. -->
  <aside
      class="fixed inset-0 z-50 flex w-full shrink-0 flex-col bg-panel transition-transform duration-200 max-md:[&_nav_a]:py-2.5 max-md:[&_nav_a]:text-[15px] md:static md:z-auto md:w-64 md:translate-x-0 md:border-r md:border-line"
      :class="open ? 'translate-x-0' : '-translate-x-full'"
  >
    <div class="flex h-12 items-center gap-2 px-3">
      <NuxtLink to="/now" class="flex min-w-0 flex-1 items-center gap-2">
        <div class="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent-300 to-accent-600 shadow-lg shadow-accent-600/30">
          <OrreryMark class="size-4 text-zinc-950" />
        </div>
        <span class="text-sm font-semibold tracking-tight">orrery</span>
        <span v-if="environment" class="rounded-md bg-sky-500/15 px-1.5 py-px text-[11px] font-semibold text-sky-700 ring-1 ring-sky-500/30 dark:text-sky-300" :title="`This is the ${environment} Orrery: its own database, apart from any other`">{{ environment }}</span>
      </NuxtLink>
      <span class="flex items-center gap-1.5 text-[11px] text-faint" :title="live === 'live' ? 'Changes through the API show here as they happen' : 'Not getting changes'">
        <span class="relative flex size-1.5">
          <span v-if="live === 'live'" class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span class="relative inline-flex size-1.5 rounded-full" :class="live === 'live' ? 'bg-emerald-400' : live === 'connecting' ? 'bg-amber-400' : 'bg-rose-500'" />
        </span>
        {{ LIVE[live] }}
      </span>
      <button type="button" class="-mr-1 grid size-8 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg md:hidden" aria-label="Close the menu" @click="open = false">
        <svg class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>

    <div class="px-2 pb-2">
      <button type="button" class="flex h-8 w-full items-center gap-2 rounded-lg bg-well px-2.5 text-[13px] text-faint ring-1 ring-line transition-colors hover:text-muted" @click="palette = true">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span class="flex-1 text-left">Jump to…</span>
        <KeyHint>⌘K</KeyHint>
      </button>
    </div>

    <nav class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3">
      <NuxtLink
          to="/now"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors"
          :class="route.path === '/now' ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
      >
        <svg class="size-4 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3 4 14h7l-1 7 9-11h-7l1-7Z" /></svg>
        <span class="flex-1">Now across projects</span>
        <span v-if="nowCount" class="font-mono text-[11px] text-faint tabular-nums">{{ nowCount }}</span>
      </NuxtLink>

      <NuxtLink
          to="/mine"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors"
          :class="route.path === '/mine' ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
      >
        <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></svg>
        <span class="flex-1">My issues</span>
        <span v-if="urgentCount" class="rounded-full bg-accent-500 px-1.5 font-mono text-[10px] font-medium text-white tabular-nums" :title="`${urgentCount} urgent`">{{ urgentCount }}</span>
        <span v-if="mineCount" class="font-mono text-[11px] text-faint tabular-nums">{{ mineCount }}</span>
      </NuxtLink>

      <NuxtLink
          to="/connect"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors"
          :class="route.path === '/connect' ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
      >
        <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></svg>
        <span class="flex-1">Connect an agent</span>
      </NuxtLink>

      <div class="label mt-4 mb-1 flex items-center gap-1 px-2">
        <span class="flex-1">Projects</span>
        <span v-if="projects.length" class="font-mono normal-case tabular-nums">{{ projects.length }}</span>
        <button
            v-if="projects.length"
            type="button"
            class="grid size-5 place-items-center rounded text-faint hover:bg-hover hover:text-fg"
            :title="allOpen ? 'Fold every project' : 'Open every project'"
            :aria-label="allOpen ? 'Fold every project' : 'Open every project'"
            @click="setFolds(ordered.map(p => p.id), !allOpen)"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path :d="allOpen ? 'm7 4 5 5 5-5M7 20l5-5 5 5' : 'm7 9 5-5 5 5M7 15l5 5 5-5'" /></svg>
        </button>
        <button type="button" class="grid size-5 place-items-center rounded text-faint hover:bg-hover hover:text-fg" title="New project" aria-label="New project" @click="newProject = true">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <!-- Every project, with its pages under it when it's open: Issues, Roadmap, Docs, Settings. -->
      <div
          v-for="(project, index) in ordered"
          :key="project.id"
          class="relative flex flex-col gap-0.5 transition-opacity"
          :class="dragging === project.id && 'opacity-40'"
          @dragover="onDragOver($event, index)"
          @drop.prevent="onDrop"
      >
        <span v-if="dropAt === index && dragging" class="pointer-events-none absolute inset-x-2 -top-1.5 h-0.5 rounded-full bg-accent-500" />
        <span v-if="dropAt === index + 1 && index === ordered.length - 1 && dragging" class="pointer-events-none absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full bg-accent-500" />
        <div class="group flex items-center rounded-lg transition-colors hover:bg-hover">
          <NuxtLink
              :to="`/p/${project.id}`"
              draggable="true"
              title="Drag to rearrange (or ⌥↑ / ⌥↓)"
              class="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-lg py-1.5 pl-2 text-[13px] active:cursor-grabbing"
              :class="route.params.project === project.id ? 'font-medium text-fg' : 'text-muted hover:text-fg'"
              :aria-expanded="isOpen(project.id)"
              @dragstart="dragging = project.id; $event.dataTransfer?.setData('text/plain', project.id)"
              @dragend="onDragEnd"
              @keydown.alt.up.prevent="nudge(project.id, -1, $event)"
              @keydown.alt.down.prevent="nudge(project.id, 1, $event)"
              @keydown.right.exact.prevent="setFolds([project.id], true)"
              @keydown.left.exact.prevent="setFolds([project.id], false)"
          >
            <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.iconColor" class="size-3.5" />
            <ProgressRing v-else :kinds="project.board.kinds" bare :size="14" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <span v-if="unseenIn(project)" class="unseen-dot" :title="`${unseenIn(project)} changed since you last looked`" />
            <span v-if="project.board.kinds.started" class="flex items-center gap-1 rounded-full bg-accent-500/12 px-1.5 font-mono text-[10px] text-accent-600 tabular-nums dark:text-accent-300" :title="`${project.board.kinds.started} being worked on`">
              <span class="size-1 rounded-full bg-accent-500" />{{ project.board.kinds.started }}
            </span>
            <span class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ project.board.kinds.done }}/{{ progress(project.board.kinds).total }}</span>
          </NuxtLink>
          <button
              type="button"
              class="mr-1 ml-0.5 grid size-5 shrink-0 place-items-center rounded text-faint hover:text-fg"
              :title="isOpen(project.id) ? 'Fold its pages (←)' : 'Show its pages (→)'"
              :aria-label="isOpen(project.id) ? `Fold ${project.name}` : `Open ${project.name}`"
              :aria-expanded="isOpen(project.id)"
              @click="toggle(project.id)"
          >
            <svg class="size-3 transition-transform duration-150" :class="isOpen(project.id) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>
        <div v-if="isOpen(project.id)" class="mb-2 flex flex-col gap-0.5">
          <NuxtLink
              v-for="section in sectionsOf(project, route.path, schedulesOf(project.id).length, sessions[project.id]?.length ?? 0)"
              :key="section.id"
              :to="section.to"
              class="ml-5 flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] transition-colors"
              :class="section.active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
          >
            <SectionIcon :section="section.id" class="text-faint" />
            <span class="flex-1">{{ section.label }}</span>
            <span v-if="section.count" class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ section.count }}</span>
          </NuxtLink>
        </div>
      </div>
      <p v-if="ready && !projects.length" class="px-2 py-1 text-xs text-faint">None yet: start one with +.</p>
    </nav>

    <!-- Every Claude session working on a project, apart from the projects so they stay short. -->
    <div v-if="allSessions.length" class="flex max-h-56 shrink-0 flex-col border-t border-line px-2 pt-2 pb-2">
      <div class="label mb-1 flex items-center gap-1 px-2">
        <span class="flex-1">Sessions</span>
        <span class="font-mono normal-case tabular-nums">{{ allSessions.length }}</span>
      </div>
      <div class="flex min-h-0 flex-col gap-0.5 overflow-y-auto">
        <NuxtLink
            v-for="{session, project} in allSessions"
            :key="session.id"
            :to="`/p/${project.id}/sessions#session-${session.id}`"
            class="flex items-center gap-2 rounded-lg px-2 py-1 text-[12px] text-muted transition-colors hover:bg-hover hover:text-fg"
            :title="session.cwd ? `${project.name} · ${session.cwd}` : project.name"
        >
          <SessionDot :session="session" />
          <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
          <span class="flex min-w-0 max-w-[40%] items-center gap-1 text-[11px] text-faint">
            <ProjectIcon v-if="project.icon && heroicon(project.icon)" :icon="project.icon" :color="project.iconColor" class="size-3" />
            <span class="truncate">{{ project.name }}</span>
          </span>
          <span class="shrink-0 text-[11px]" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">{{ SESSION_STATE[session.state] }}</span>
        </NuxtLink>
      </div>
    </div>

    <div class="shrink-0 border-t border-line p-2">
      <a
          href="https://github.com/steffendybvik/orrery"
          target="_blank"
          rel="noopener"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-muted transition-colors hover:bg-hover hover:text-fg"
          title="Orrery's code, issues and releases on GitHub"
      >
        <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></svg>
        <span class="flex-1">GitHub</span>
        <svg class="size-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
      </a>
      <div class="mt-1 hidden items-center justify-between px-1 text-[11px] text-faint md:flex">
        <span><KeyHint>j</KeyHint> <KeyHint>k</KeyHint> move</span>
        <span><KeyHint>↵</KeyHint> open</span>
        <span><KeyHint>g</KeyHint> <KeyHint>n</KeyHint> <KeyHint>u</KeyHint></span>
      </div>
    </div>
  </aside>
</template>
