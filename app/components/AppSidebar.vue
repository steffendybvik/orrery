<script setup lang="ts">
import type {Issue} from '#shared/roadmap'

// Every project with its progress and how many issues are being worked on; Now across projects on top.
const {projects, ready, live} = useRoadmaps()
const route = useRoute()
const open = useState('sidebar-open', () => false)
const palette = useState('palette-open', () => false)

watch(() => route.fullPath, () => {
    open.value = false
})

/** Top-level issues in Doing or Now, as the Now page lists them. */
const nowCount = computed(() => projects.value.reduce((sum, p) =>
    sum + p.board.chunks.reduce((n, c) => n + c.tasks.filter((t: Issue) => t.column === 'doing' || t.column === 'now').length, 0), 0))
const urgentCount = computed(() => projects.value.reduce((sum, p) => sum + urgentIssues(p).length, 0))
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

function nudge(id: string, by: number, event: KeyboardEvent) {
    const from = ordered.value.findIndex(p => p.id === id)
    move(id, from + by)
    nextTick(() => (event.target as HTMLElement).focus())
}

</script>

<template>
  <div v-if="open" class="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] md:hidden" @click="open = false" />
  <aside
      class="fixed inset-y-0 left-0 z-50 flex w-64 shrink-0 flex-col border-r border-line bg-panel transition-transform duration-200 md:static md:z-auto md:translate-x-0"
      :class="open ? 'translate-x-0 shadow-2xl' : '-translate-x-full'"
  >
    <div class="flex h-12 items-center gap-2 px-3">
      <NuxtLink to="/now" class="flex min-w-0 flex-1 items-center gap-2">
        <div class="grid size-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent-300 to-accent-600 shadow-lg shadow-accent-600/30">
          <svg class="size-4 text-zinc-950" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-25 12 12)" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /><circle cx="19.4" cy="8.6" r="1.6" fill="currentColor" stroke="none" /></svg>
        </div>
        <span class="text-sm font-semibold tracking-tight">orrery</span>
      </NuxtLink>
      <span class="flex items-center gap-1.5 text-[11px] text-faint" :title="live === 'live' ? 'Changes through the API show here as they happen' : 'Not getting changes'">
        <span class="relative flex size-1.5">
          <span v-if="live === 'live'" class="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span class="relative inline-flex size-1.5 rounded-full" :class="live === 'live' ? 'bg-emerald-400' : live === 'connecting' ? 'bg-amber-400' : 'bg-rose-500'" />
        </span>
        {{ LIVE[live] }}
      </span>
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
          to="/urgent"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors"
          :class="route.path === '/urgent' ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
      >
        <PriorityIcon priority="P0" :size="16" />
        <span class="flex-1">Urgent</span>
        <span v-if="urgentCount" class="rounded-full bg-accent-500 px-1.5 font-mono text-[10px] font-medium text-white tabular-nums">{{ urgentCount }}</span>
      </NuxtLink>

      <NuxtLink
          to="/connect"
          class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors"
          :class="route.path === '/connect' ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
      >
        <svg class="size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8" /></svg>
        <span class="flex-1">Connect an agent</span>
      </NuxtLink>

      <div class="label mt-4 mb-1 flex items-center px-2">
        <span class="flex-1">Projects</span>
        <span v-if="projects.length" class="font-mono normal-case tabular-nums">{{ projects.length }}</span>
      </div>
      <!-- Every project with its pages under it: Issues, Roadmap, Docs. -->
      <div
          v-for="(project, index) in ordered"
          :key="project.id"
          class="relative mb-2 flex flex-col gap-0.5 transition-opacity"
          :class="dragging === project.id && 'opacity-40'"
          @dragover="onDragOver($event, index)"
          @drop.prevent="onDrop"
      >
        <span v-if="dropAt === index && dragging" class="pointer-events-none absolute inset-x-2 -top-1.5 h-0.5 rounded-full bg-accent-500" />
        <span v-if="dropAt === index + 1 && index === ordered.length - 1 && dragging" class="pointer-events-none absolute inset-x-2 -bottom-1.5 h-0.5 rounded-full bg-accent-500" />
        <NuxtLink
            :to="`/p/${project.id}`"
            draggable="true"
            title="Drag to rearrange (or ⌥↑ / ⌥↓)"
            class="flex cursor-grab items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors hover:bg-hover active:cursor-grabbing"
            :class="route.params.project === project.id ? 'font-medium text-fg' : 'text-muted hover:text-fg'"
            @dragstart="dragging = project.id; $event.dataTransfer?.setData('text/plain', project.id)"
            @dragend="onDragEnd"
            @keydown.alt.up.prevent="nudge(project.id, -1, $event)"
            @keydown.alt.down.prevent="nudge(project.id, 1, $event)"
        >
          <ProgressRing :counts="project.board.counts" bare :size="14" />
          <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
          <span v-if="project.board.counts.doing" class="flex items-center gap-1 rounded-full bg-accent-500/12 px-1.5 font-mono text-[10px] text-accent-600 tabular-nums dark:text-accent-300" :title="`${project.board.counts.doing} being worked on`">
            <span class="size-1 rounded-full bg-accent-500" />{{ project.board.counts.doing }}
          </span>
          <span class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ project.board.counts.done }}/{{ progress(project.board.counts).total }}</span>
        </NuxtLink>
        <NuxtLink
            v-for="section in sectionsOf(project, route.path)"
            :key="section.id"
            :to="section.to"
            class="ml-5 flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] transition-colors"
            :class="section.active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
        >
          <SectionIcon :section="section.id" class="text-faint" />
          <span class="flex-1">{{ section.label }}</span>
          <span v-if="section.count" class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ section.count }}</span>
        </NuxtLink>
        <div v-for="session in sessions[project.id] ?? []" :key="session.id" class="ml-5 flex items-center gap-2 px-2 py-1 text-[12px] text-muted" :title="session.cwd">
          <SessionDot :session="session" />
          <span class="min-w-0 flex-1 truncate">{{ session.name }}</span>
          <span class="text-[11px]" :class="session.state === 'waiting' ? 'text-rose-600 dark:text-rose-400' : 'text-faint'">{{ SESSION_STATE[session.state] }}</span>
        </div>
      </div>
      <p v-if="ready && !projects.length" class="px-2 py-1 text-xs text-faint">None yet: create one through the API.</p>
    </nav>

    <div class="hidden border-t border-line p-2 md:block">
      <div class="flex items-center justify-between px-1 text-[11px] text-faint">
        <span><KeyHint>j</KeyHint> <KeyHint>k</KeyHint> move</span>
        <span><KeyHint>↵</KeyHint> open</span>
        <span><KeyHint>g</KeyHint> <KeyHint>n</KeyHint> <KeyHint>u</KeyHint></span>
      </div>
    </div>
  </aside>
</template>
