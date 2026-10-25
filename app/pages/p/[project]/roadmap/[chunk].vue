<script setup lang="ts">
import type {Priority} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// A chunk's page: its summary, priority and progress, the Claude sessions to point at it, and its issues
// by status, each status with a button to point the sessions at just those. Esc goes back to the roadmap.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {matches, active} = useFilters()

const project = computed(() => byId(route.params.project as string))
const chunkId = computed(() => route.params.chunk === 'none' ? '' : String(route.params.chunk))
const chunk = computed(() => project.value?.board.chunks.find(c => c.id === chunkId.value || c.aliases.includes(chunkId.value)))
// A name it had before (/roadmap/joints) goes to its own address.
watch(chunk, c => {
    if (c && c.id && c.id !== chunkId.value) router.replace(chunkPath(String(route.params.project), c.id))
}, {immediate: true})
const shown = computed(() => {
    if (!chunk.value) return []
    return [active.value ? {...chunk.value, tasks: filterTree(chunk.value.tasks, matches)} : chunk.value]
})
const share = computed(() => chunk.value ? progress(chunk.value.counts) : null)

// How much it matters, set by the owner; the board updates live once it's saved.
const {load} = useOwner()
const savingPriority = ref(false)
async function setPriority(priority: Priority | '') {
    if (!project.value || !chunk.value?.id) return
    savingPriority.value = true
    try {
        await $fetch(`/api/projects/${encodeURIComponent(project.value.id)}/chunks/${encodeURIComponent(chunk.value.id)}`, {
            method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: {priority: priority || null},
        })
    } finally {
        savingPriority.value = false
    }
}

function onKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null
    if (event.key !== 'Escape' || useState('palette-open').value) return
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
    router.push(`/p/${route.params.project}/roadmap`)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

useHead(() => ({title: chunk.value ? `${chunk.value.title} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <NuxtLink :to="`/p/${project.id}/roadmap`" class="-ml-1 hidden rounded-md p-1 text-faint hover:bg-hover hover:text-fg md:block" title="Back to the roadmap (Esc)" aria-label="Back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </NuxtLink>
      <nav class="flex min-w-0 items-center gap-1.5 text-sm" aria-label="Breadcrumb">
        <NuxtLink :to="`/p/${project.id}`" class="shrink-0 font-medium hover:text-fg">{{ project.name }}</NuxtLink>
        <span class="text-faint">/</span>
        <NuxtLink :to="`/p/${project.id}/roadmap`" class="shrink-0 text-muted hover:text-fg">Roadmap</NuxtLink>
        <template v-if="chunk">
          <span class="text-faint">/</span>
          <span class="truncate text-fg">{{ chunk.title }}</span>
        </template>
      </nav>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <template v-if="project && chunk && share">
      <header class="mx-auto flex max-w-5xl animate-fade-up flex-col gap-4 px-4 pt-8 pb-6 sm:px-8">
        <div class="flex items-center gap-3 text-xs">
          <span class="flex items-center gap-2" :class="COLUMN_STYLE[chunk.column].text">
            <StatusIcon :column="chunk.column" :progress="share.share" />
            {{ COLUMN_STYLE[chunk.column].label }}
          </span>
          <span v-if="chunk.id" class="flex items-center gap-1.5">
            <span class="font-mono text-faint">{{ chunk.id }}</span>
            <CopyButton :text="chunk.id" />
          </span>
          <label v-if="chunk.id" class="flex items-center gap-1.5 text-muted">
            <PriorityIcon :priority="chunk.priority" />
            <select
                :value="chunk.priority ?? ''"
                aria-label="Priority"
                class="h-7 rounded-md bg-well px-1.5 text-xs text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none disabled:opacity-50"
                :disabled="savingPriority"
                @change="setPriority(($event.target as HTMLSelectElement).value as Priority | '')"
            >
              <option value="">No priority</option>
              <option v-for="p in PRIORITIES" :key="p" :value="p">{{ p }} · {{ PRIORITY_LABEL[p] }}</option>
            </select>
          </label>
        </div>
        <h1 class="text-xl font-semibold tracking-tight text-fg sm:text-2xl" :class="!chunk.id && 'text-muted italic'">{{ chunk.title }}</h1>
        <MarkdownView v-if="chunk.summary" :source="chunk.summary" />
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-faint">
          <ProgressRing :counts="chunk.counts" :size="16" />
          <span>{{ chunk.tasks.length }} {{ chunk.tasks.length === 1 ? 'issue' : 'issues' }}<template v-if="share.total !== chunk.tasks.length"> · {{ share.total }} with sub-issues</template></span>
          <ColumnBar :counts="chunk.counts" class="max-w-64 flex-1" />
        </div>
        <SessionsPanel v-if="chunk.column !== 'done'" :project="project.id" :chunk="chunk.id || 'none'" />
      </header>
      <ViewToolbar>
        <span class="label">Issues</span>
        <template #end>
          <FilterBar />
          <button type="button" class="flex h-7 items-center gap-1.5 rounded-md bg-accent-500 px-2.5 text-xs font-medium text-white hover:opacity-90" title="New issue (c)" @click="useNewIssue().open(project.id, chunk.id || undefined)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New issue
          </button>
        </template>
      </ViewToolbar>
      <ListView v-if="shown[0]?.tasks.length" :chunks="shown" :project="project.id" group="status" :show-chunk="false">
        <template #group-end="{column}">
          <StatusFocus :project="project.id" :chunk="chunk.id || 'none'" :column="column" />
        </template>
      </ListView>
      <p v-else class="px-4 py-16 text-center text-sm text-muted">{{ active ? 'No issue in this chunk matches the filters.' : 'No issues in this chunk yet.' }}</p>
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">
      No chunk “{{ route.params.chunk }}”. <NuxtLink :to="`/p/${route.params.project}/roadmap`" class="ml-1 text-fg underline">Back to the roadmap</NuxtLink>
    </div>
  </div>
</template>
