<script setup lang="ts">
import type {Doc} from '#shared/roadmap'

// One doc, its Markdown drawn as a page with its table of contents beside it. Read again when it
// changes through the API.
const route = useRoute()
const {byId, ready} = useRoadmaps()
const {who} = useOwner()
const project = computed(() => byId(route.params.project as string))
const summary = computed(() => project.value?.docs.find(d => d.id === route.params.doc))
// Open, it's seen, and stays seen as it changes in front of you.
const {seeDoc} = useUnseen()
watch(() => summary.value?.updated_at, () => {
    if (project.value && summary.value) seeDoc(project.value.id, summary.value)
}, {immediate: true})

const doc = ref<Doc | null>(null)
const missing = ref(false)
// What changed since it was last read is tinted: against the text from the visit before this one, kept
// for the whole visit, so changes coming in while it's open are tinted too.
const {lastRead, read} = useUnseen()
const before = ref<{key: string, body?: string} | null>(null)
// A reply that comes after you've moved on (another doc, or a newer change) is let go.
watch(() => [route.params.project, route.params.doc, summary.value?.updated_at] as const, async ([p, d], _, onCleanup) => {
    if (!p || !d) return
    let left = false
    onCleanup(() => left = true)
    try {
        const fetched = await $fetch<Doc>(`/api/projects/${encodeURIComponent(String(p))}/docs/${encodeURIComponent(String(d))}`)
        if (left) return
        const key = `${fetched.project}/${fetched.id}`
        if (before.value?.key !== key) before.value = {key, body: lastRead(fetched.project, fetched.id)}
        read(fetched.project, fetched.id, fetched.body)
        doc.value = fetched
        missing.value = false
    } catch {
        if (!left) missing.value = true
    }
}, {immediate: true})

const rendered = computed(() => doc.value ? renderMarkdown(doc.value.body, doc.value.title, before.value?.body) : null)
const headings = computed(() => rendered.value?.headings ?? [])
const scroller = ref<HTMLElement | null>(null)
const {size} = useDocSize()
const sizes = [{value: 'sm' as const, label: 'S'}, {value: 'md' as const, label: 'M'}, {value: 'lg' as const, label: 'L'}]

useHead(() => ({title: doc.value ? `${doc.value.title} · Orrery` : 'Orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
      <template v-if="doc">
        <span class="text-faint">/</span>
        <span class="min-w-0 truncate text-sm text-muted">{{ doc.title }}</span>
      </template>
    </template>
  </PageHeader>

  <div v-if="project" class="flex min-h-0 flex-1 flex-col md:flex-row">
  <DocsNav :project="project" />
  <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
    <div v-if="doc && !missing" :key="doc.id" class="mx-auto flex max-w-6xl animate-fade-up gap-12 px-4 py-8 sm:px-8 sm:py-12">
    <article class="min-w-0 max-w-3xl flex-1">
      <header class="mb-8 flex flex-col gap-3 border-b border-line pb-6">
        <h1 class="text-3xl font-semibold tracking-tight text-fg">{{ doc.title }}</h1>
        <div class="flex items-center gap-2 text-xs text-faint">
          <PersonAvatar :name="doc.created_by" :size="16" />
          <span class="text-muted">{{ who(doc.created_by) }}</span>
          <span>· updated {{ ago(doc.updated_at) }}</span>
          <span v-if="doc.protected" class="flex items-center gap-1" title="Only the owner can delete it">· protected</span>
          <span class="ml-auto flex items-center gap-2">
            <SegmentedControl v-model="size" :options="sizes" class="[&_button]:px-2 [&_button]:py-0.5" title="Text size" />
            <span class="font-mono">{{ doc.id }}</span>
            <CopyButton :text="doc.id" />
          </span>
        </div>
        <p v-if="rendered?.changed" class="flex items-center gap-2 text-xs text-accent-600 dark:text-accent-400">
          <span class="unseen-dot" />{{ rendered.changed }} {{ rendered.changed === 1 ? 'part' : 'parts' }} changed since you last read it, tinted below
        </p>
      </header>
      <MarkdownView :source="doc.body" :title="doc.title" :before="before?.body" :data-size="size" />
      <p class="mt-12 rounded-lg bg-well px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-line">PUT /api/projects/{{ doc.project }}/docs/{{ doc.id }}</p>
    </article>
    <aside v-if="headings.length" class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
    <div v-else-if="missing && ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No doc “{{ route.params.doc }}”.</div>
  </div>
  </div>
</template>
