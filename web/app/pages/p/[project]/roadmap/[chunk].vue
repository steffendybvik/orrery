<script setup lang="ts">
import type {Priority} from '#shared/roadmap'

// A chunk's page: its summary, priority and progress, the Claude sessions to point at it, and its issues
// by status, each status with a button to point the sessions at just those. Its title and summary edit
// in place and it can be removed, as the owner. Esc goes back to the roadmap.
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
const share = computed(() => chunk.value ? progress(chunk.value.kinds) : null)
const {look} = useStatuses()

// Changes, as the owner; the page catches up live once they're saved. `failed` holds why the last didn't.
const {load} = useOwner()
const saving = ref(false)
const failed = ref('')
const api = computed(() => project.value && chunk.value?.id ? `/api/projects/${encodeURIComponent(project.value.id)}/chunks/${encodeURIComponent(chunk.value.id)}` : '')
async function save(body: Record<string, unknown>): Promise<boolean> {
    if (!api.value) return false
    saving.value = true
    failed.value = ''
    try {
        await $fetch(api.value, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body})
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    } finally {
        saving.value = false
    }
}

// How much it matters.
const setPriority = (priority: Priority | '') => save({priority: priority || null})

// The title, edited in place: Enter saves, Esc puts it back.
const editingTitle = ref(false)
const title = ref('')
const titleInput = ref<HTMLInputElement | null>(null)
function editTitle() {
    if (!chunk.value?.id) return
    title.value = chunk.value.title
    editingTitle.value = true
    nextTick(() => titleInput.value?.select())
}
async function saveTitle() {
    if (!editingTitle.value) return
    const next = title.value.trim()
    if (next && next !== chunk.value?.title && !await save({title: next})) return
    editingTitle.value = false
}

// The summary, in Markdown: ⌘↵ saves, Esc leaves it as it was.
const editingSummary = ref(false)
const summary = ref('')
const summaryInput = ref<HTMLTextAreaElement | null>(null)
function editSummary() {
    summary.value = chunk.value?.summary ?? ''
    editingSummary.value = true
    nextTick(() => summaryInput.value?.focus())
}
async function saveSummary() {
    const next = summary.value.trim()
    if (next !== (chunk.value?.summary ?? '') && !await save({summary: next || null})) return
    editingSummary.value = false
}
watch(() => chunk.value?.id, () => editingTitle.value = editingSummary.value = confirmingRemove.value = false)

// Removing it leaves its issues in no chunk.
const confirmingRemove = ref(false)
async function remove() {
    if (!api.value || !project.value) return
    saving.value = true
    failed.value = ''
    try {
        await $fetch(api.value, {method: 'DELETE', headers: {'Orrery-Actor': await load()}})
        router.push(`/p/${project.value.id}/roadmap`)
    } catch (error) {
        failed.value = errorMessage(error, 'remove')
    } finally {
        saving.value = false
        confirmingRemove.value = false
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
      <UiButton :to="`/p/${project.id}/roadmap`" variant="ghost" size="xs" square class="-ml-1 max-md:hidden" title="Back to the roadmap (Esc)" aria-label="Back">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6" /></svg>
      </UiButton>
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
          <span class="flex items-center gap-2" :style="{color: look(chunk.column).color}">
            <StatusIcon :column="chunk.column" :progress="share.share" />
            {{ look(chunk.column).label }}
          </span>
          <span v-if="chunk.id" class="flex items-center gap-1.5">
            <span class="font-mono text-faint">{{ chunk.id }}</span>
            <CopyButton :text="chunk.id" />
          </span>
          <PropertyPicker
              v-if="chunk.id"
              :model-value="chunk.priority ?? ''"
              :options="PRIORITY_OPTIONS"
              label="Chunk priority"
              placeholder="Find a priority…"
              field
              small
              :disabled="saving"
              @update:model-value="setPriority($event as Priority | '')"
          >
            <PriorityIcon :priority="chunk.priority" />
            <span class="truncate" :class="!chunk.priority && 'text-faint'">{{ chunk.priority ? `${chunk.priority} · ${PRIORITY_LABEL[chunk.priority]}` : 'No priority' }}</span>
            <template #option="{option}">
              <PriorityIcon :priority="option.value || undefined" />
              <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
            </template>
          </PropertyPicker>
          <span v-if="chunk.id" class="ml-auto flex items-center gap-2">
            <UiConfirm v-if="confirmingRemove" inline :busy="saving" @confirm="remove" @cancel="confirmingRemove = false">
              Remove chunk {{ chunk.id }}? Its {{ chunk.tasks.length }} {{ chunk.tasks.length === 1 ? 'issue stays' : 'issues stay' }}, in no chunk.
            </UiConfirm>
            <UiButton
                v-else
                variant="danger-ghost"
                size="xs"
                square
                title="Remove this chunk"
                aria-label="Remove this chunk"
                @click="confirmingRemove = true"
            >
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            </UiButton>
          </span>
        </div>
        <input
            v-if="editingTitle"
            ref="titleInput"
            v-model="title"
            aria-label="Title"
            class="-mx-2 rounded-lg bg-well px-2 py-0.5 text-xl font-semibold tracking-tight text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none sm:text-2xl"
            :disabled="saving"
            @keydown.enter.prevent="saveTitle"
            @keydown.esc.stop.prevent="editingTitle = false"
            @blur="saveTitle"
        >
        <h1
            v-else
            class="-mx-2 rounded-lg px-2 py-0.5 text-xl font-semibold tracking-tight text-fg sm:text-2xl"
            :class="chunk.id ? 'cursor-text hover:bg-hover' : 'text-muted italic'"
            :title="chunk.id ? 'Click to edit' : undefined"
            @click="editTitle"
        >{{ chunk.title }}</h1>
        <section v-if="editingSummary" class="flex flex-col gap-2" @keydown.esc.stop.prevent="editingSummary = false">
          <textarea
              ref="summaryInput"
              v-model="summary"
              aria-label="Summary"
              placeholder="What it's for, in Markdown"
              rows="5"
              class="field-sizing-content min-h-28 w-full resize-y rounded-xl bg-well px-4 py-3 font-mono text-[13px] leading-6 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              :disabled="saving"
              @keydown.meta.enter.prevent="saveSummary"
              @keydown.ctrl.enter.prevent="saveSummary"
          />
          <div class="flex items-center justify-end gap-2">
            <span class="mr-auto text-xs text-faint">Markdown</span>
            <UiButton :disabled="saving" @click="editingSummary = false">Cancel <KeyHint>esc</KeyHint></UiButton>
            <UiButton variant="primary" :disabled="saving" @click="saveSummary">
              {{ saving ? 'Saving…' : 'Save' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
            </UiButton>
          </div>
        </section>
        <section v-else-if="chunk.id" class="group relative">
          <UiButton
              v-if="chunk.summary"
              class="absolute -top-1 right-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
              @click="editSummary"
          >Edit</UiButton>
          <MarkdownView v-if="chunk.summary" :source="chunk.summary" />
          <button v-else type="button" class="text-sm text-faint italic hover:text-muted" @click="editSummary">No summary. Add one</button>
        </section>
        <MarkdownView v-else-if="chunk.summary" :source="chunk.summary" />
        <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-faint">
          <ProgressRing :kinds="chunk.kinds" :size="16" />
          <span>{{ chunk.tasks.length }} {{ chunk.tasks.length === 1 ? 'issue' : 'issues' }}<template v-if="share.total !== chunk.tasks.length"> · {{ share.total }} with sub-issues</template></span>
          <ColumnBar :counts="chunk.counts" class="max-w-64 flex-1" />
        </div>
        <SessionsPanel v-if="!isClosed(chunk.kind)" :project="project.id" :chunk="chunk.id || 'none'" />
      </header>
      <ViewToolbar>
        <span class="label">Issues</span>
        <template #end>
          <FilterBar />
          <UiButton variant="primary" class="shrink-0" title="New issue (c)" @click="useNewIssue().open(project.id, chunk.id || undefined)">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New issue
          </UiButton>
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
