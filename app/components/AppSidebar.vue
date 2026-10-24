<script setup lang="ts">
import type {Counts, Issue} from '#shared/roadmap'

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

// A project folds open to its Issues and Docs; the one on screen is always open.
const unfolded = ref<Record<string, boolean>>({})
const isUnfolded = (id: string) => unfolded.value[id] ?? route.params.project === id
const openIssues = (counts: Counts) => progress(counts).total - counts.done
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

      <div class="label mt-4 mb-1 flex items-center px-2">
        <span class="flex-1">Projects</span>
        <span v-if="projects.length" class="font-mono normal-case tabular-nums">{{ projects.length }}</span>
      </div>
      <div v-for="project in projects" :key="project.id" class="flex flex-col gap-0.5">
        <div
            class="group flex items-center gap-1 rounded-lg pr-2 text-[13px] transition-colors"
            :class="route.params.project === project.id && !isUnfolded(project.id) ? 'bg-active' : 'hover:bg-hover'"
        >
          <button
              type="button"
              class="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-fg"
              :aria-label="isUnfolded(project.id) ? 'Fold' : 'Unfold'"
              @click="unfolded = {...unfolded, [project.id]: !isUnfolded(project.id)}"
          >
            <svg class="size-3 transition-transform" :class="isUnfolded(project.id) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
          </button>
          <NuxtLink :to="`/p/${project.id}`" class="flex min-w-0 flex-1 items-center gap-2 py-1.5" :class="route.params.project === project.id ? 'font-medium text-fg' : 'text-muted group-hover:text-fg'">
            <ProgressRing :counts="project.board.counts" bare :size="14" />
            <span class="min-w-0 flex-1 truncate">{{ project.name }}</span>
            <span v-if="project.board.counts.doing" class="flex items-center gap-1 rounded-full bg-accent-500/12 px-1.5 font-mono text-[10px] text-accent-600 tabular-nums dark:text-accent-300" :title="`${project.board.counts.doing} being worked on`">
              <span class="size-1 rounded-full bg-accent-500" />{{ project.board.counts.doing }}
            </span>
            <span class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ project.board.counts.done }}/{{ progress(project.board.counts).total }}</span>
          </NuxtLink>
        </div>
        <template v-if="isUnfolded(project.id)">
          <NuxtLink
              v-for="item in [
                  {to: `/p/${project.id}`, label: 'Issues', count: openIssues(project.board.counts), active: route.params.project === project.id && !route.path.includes('/docs')},
                  {to: `/p/${project.id}/docs`, label: 'Docs', count: project.docs.length, active: route.params.project === project.id && route.path.includes('/docs')},
              ]"
              :key="item.label"
              :to="item.to"
              class="ml-7 flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] transition-colors"
              :class="item.active ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'"
          >
            <svg v-if="item.label === 'Issues'" class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></svg>
            <svg v-else class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /></svg>
            <span class="flex-1">{{ item.label }}</span>
            <span v-if="item.count" class="font-mono text-[11px] font-normal text-faint tabular-nums">{{ item.count }}</span>
          </NuxtLink>
        </template>
      </div>
      <p v-if="ready && !projects.length" class="px-2 py-1 text-xs text-faint">None yet: create one through the API.</p>
    </nav>

    <div class="flex flex-col gap-2 border-t border-line p-2">
      <ThemeToggle />
      <div class="hidden items-center justify-between px-1 text-[11px] text-faint md:flex">
        <span><KeyHint>j</KeyHint> <KeyHint>k</KeyHint> move</span>
        <span><KeyHint>↵</KeyHint> open</span>
        <span><KeyHint>g</KeyHint> <KeyHint>n</KeyHint> <KeyHint>u</KeyHint></span>
      </div>
    </div>
  </aside>
</template>
