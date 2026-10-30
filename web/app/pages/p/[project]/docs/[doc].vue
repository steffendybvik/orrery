<script setup lang="ts">
import type {DeletedDoc, Doc} from '#shared/roadmap'
import {fullId} from '#shared/roadmap'

// One doc, its Markdown drawn as a page with its table of contents beside it. Read again when it
// changes through the API. Its title and text edit in place, and it can be removed, as the owner.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const {who, load} = useOwner()
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

// Its title and text, edited together: ⌘↵ saves, Esc leaves it as it was. Saved, your own change isn't
// tinted as one to read.
const editing = ref(false)
const title = ref('')
const body = ref('')
const bodyInput = ref<HTMLTextAreaElement | null>(null)
const editedFrom = ref('')
const saving = ref(false)
const saveFailed = ref('')
// An image pasted, dropped or picked goes in as Markdown where the cursor is.
const {uploading, failed: uploadError, upload, reset: resetUploads, over, on: drop} = useImageUpload(body, bodyInput)
function edit() {
    if (!doc.value) return
    resetUploads()
    title.value = doc.value.title
    body.value = doc.value.body
    editedFrom.value = doc.value.updated_at
    saveFailed.value = ''
    editing.value = true
    nextTick(() => bodyInput.value?.focus())
}
async function save() {
    if (!doc.value || uploading.value || !title.value.trim()) return
    const change = {
        ...title.value.trim() !== doc.value.title ? {title: title.value.trim()} : {},
        ...body.value.trim() !== doc.value.body.trim() ? {body: body.value.trim()} : {},
    }
    if (!Object.keys(change).length) {
        editing.value = false
        return
    }
    saving.value = true
    saveFailed.value = ''
    try {
        const saved = await $fetch<Doc>(`/api/projects/${encodeURIComponent(doc.value.project)}/docs/${encodeURIComponent(doc.value.id)}`, {
            method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: change,
        })
        before.value = {key: `${saved.project}/${saved.id}`, body: saved.body}
        read(saved.project, saved.id, saved.body)
        doc.value = saved
        editing.value = false
    } catch (error) {
        saveFailed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}

// Its past, in place of the page (ORR-675). A restore comes back as the doc, which is then what's read.
const history = ref(false)
function restored(saved: Doc) {
    before.value = {key: `${saved.project}/${saved.id}`, body: saved.body}
    read(saved.project, saved.id, saved.body)
    doc.value = saved
    missing.value = false
    history.value = false
}

// A doc that isn't there may have been removed: then it can be read and brought back.
const removed = ref<DeletedDoc | null>(null)
watch([missing, () => route.params.doc], async ([gone]) => {
    removed.value = null
    if (!gone) return
    const asked = String(route.params.doc)
    const list = await $fetch<DeletedDoc[]>(`/api/projects/${encodeURIComponent(String(route.params.project))}/deleted-docs`).catch(() => [])
    if (missing.value && String(route.params.doc) === asked) removed.value = list.find(d => d.id === asked) ?? null
})

// Removing it, asked once more in place, then on to the project's other docs.
const removing = ref<'ask' | 'busy' | null>(null)
const removeFailed = ref('')
async function remove() {
    if (!doc.value) return
    removing.value = 'busy'
    removeFailed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(doc.value.project)}/docs/${encodeURIComponent(doc.value.id)}`, {method: 'DELETE', headers: {'Orrery-Actor': await load()}})
        router.replace(`/p/${doc.value.project}/docs`)
    } catch (error) {
        removing.value = 'ask'
        removeFailed.value = errorMessage(error, 'remove')
    }
}
watch(() => [route.params.project, route.params.doc], () => {
    editing.value = false
    history.value = false
    removing.value = null
    removeFailed.value = ''
    resetUploads()
})

const rendered = computed(() => doc.value ? renderMarkdown(doc.value.body, doc.value.title, before.value?.body) : null)
const headings = computed(() => rendered.value?.headings ?? [])
const scroller = ref<HTMLElement | null>(null)
const {size} = useDocSize()
// The text size, with the doc's id and what copies it or its address: a row of their own under the author on a phone, at the left edge (ORR-557).
const sizes = [{value: 'sm' as const, label: 'S'}, {value: 'md' as const, label: 'M'}, {value: 'lg' as const, label: 'L'}]
const address = computed(() => doc.value ? `${location.origin}/p/${encodeURIComponent(doc.value.project)}/docs/${encodeURIComponent(doc.value.id)}` : '')

useHead(() => ({title: doc.value ? `${doc.value.title} · orrery` : 'orrery'}))
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <!-- The doc's title below is the page's h1 (ORR-623). -->
      <component :is="doc ? 'span' : 'h1'" class="truncate text-sm font-medium">{{ project.name }}</component>
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
        <div class="flex items-start gap-3">
          <input
              v-if="editing"
              v-model="title"
              aria-label="Title"
              class="-mx-2 min-w-0 flex-1 rounded-lg bg-well px-2 py-0.5 text-3xl font-semibold tracking-tight text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
              :disabled="saving"
              @keydown.enter.prevent="save"
              @keydown.esc.stop.prevent="editing = false"
          >
          <h1 v-else class="min-w-0 flex-1 text-3xl font-semibold tracking-tight text-fg">{{ doc.title }}</h1>
          <div v-if="!editing" class="mt-1.5 flex shrink-0 items-center gap-1">
            <template v-if="!removing">
              <UiButton variant="ghost" title="Every saved version, with what changed" @click="history = !history">
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></svg>
                {{ history ? 'Back to the doc' : 'History' }}
              </UiButton>
              <UiButton variant="ghost" title="Edit its title and text" @click="edit">
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16Z" /><path d="m13.5 6.5 4 4" /></svg>
                Edit
              </UiButton>
              <UiButton variant="danger-ghost" title="Remove this doc" @click="removing = 'ask'">
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
                Remove
              </UiButton>
            </template>
            <UiConfirm v-else inline class="text-xs" :busy="removing === 'busy'" @confirm="remove" @cancel="removing = null">
              Remove “{{ doc.title }}”?
            </UiConfirm>
          </div>
        </div>
        <p v-if="removeFailed" class="text-xs text-rose-600 dark:text-rose-400">{{ removeFailed }}</p>
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-faint">
          <PersonAvatar :name="doc.created_by" :size="16" />
          <span class="text-muted">{{ who(doc.created_by) }}</span>
          <span>· updated {{ ago(doc.updated_at) }}</span>
          <span v-if="doc.protected" class="flex items-center gap-1" title="Only the owner can delete it">· protected</span>
          <span class="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
            <SegmentedControl v-model="size" :options="sizes" class="[&_[role=radio]]:px-2 [&_[role=radio]]:py-0.5" title="Text size" />
            <span class="whitespace-nowrap font-mono">{{ doc.id }}</span>
            <CopyButton :text="fullId('doc', doc.id, project.uid)" label="Copy id" name="this doc's id" />
            <CopyButton :text="address" label="Copy URL" name="this doc's URL" />
          </span>
        </div>
        <p v-if="rendered?.changed" class="flex items-center gap-2 text-xs text-accent-600 dark:text-accent-400">
          <span class="unseen-dot" />{{ rendered.changed }} {{ rendered.changed === 1 ? 'part' : 'parts' }} changed since you last read it, tinted below
        </p>
      </header>
      <section
          v-if="editing"
          class="relative flex flex-col gap-2 rounded-xl"
          v-on="drop"
          @keydown.esc.stop.prevent="editing = false"
      >
        <ImageDropOverlay v-if="over" />
        <p v-if="doc.updated_at !== editedFrom" class="text-xs text-amber-600 dark:text-amber-400">
          It changed while you were editing; saving replaces that change with yours.
        </p>
        <textarea
            ref="bodyInput"
            v-model="body"
            aria-label="Text"
            placeholder="Write it in Markdown (paste or drop an image)"
            rows="20"
            class="field-sizing-content min-h-80 w-full resize-y rounded-xl bg-well px-4 py-3 font-mono text-[13px] leading-6 text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
            :disabled="saving"
            @keydown.meta.enter.prevent="save"
            @keydown.ctrl.enter.prevent="save"
        />
        <div class="flex items-center justify-end gap-2">
          <ImageButton @picked="upload" />
          <span v-if="saveFailed" class="mr-auto text-xs text-rose-600 dark:text-rose-400">{{ saveFailed }}</span>
          <span v-else-if="uploading" class="mr-auto text-xs text-faint">Adding image…</span>
          <span v-else-if="uploadError" class="mr-auto text-xs text-rose-600 dark:text-rose-400">{{ uploadError }}</span>
          <span v-else class="mr-auto text-xs text-faint">Markdown</span>
          <UiButton :disabled="saving" @click="editing = false">Cancel <KeyHint>esc</KeyHint></UiButton>
          <UiButton variant="primary" :disabled="saving || !!uploading || !title.trim()" @click="save">
            {{ saving ? 'Saving…' : 'Save' }} <KeyHint class="bg-white/20 text-white ring-0">⌘↵</KeyHint>
          </UiButton>
        </div>
      </section>
      <DocHistory v-else-if="history" :project="doc.project" :doc="doc.id" :updated-at="doc.updated_at" @restored="restored" />
      <MarkdownView v-else :source="doc.body" :title="doc.title" :before="before?.body" :data-size="size" />
      <p class="mt-12 rounded-lg bg-well px-3 py-2 font-mono text-[11px] text-faint ring-1 ring-line">PUT /api/projects/{{ doc.project }}/docs/{{ doc.id }}</p>
    </article>
    <aside v-if="headings.length && !history && !editing" class="hidden w-56 shrink-0 xl:block">
      <div class="sticky top-6">
        <DocContents :headings="headings" :root="scroller" />
      </div>
    </aside>
    </div>
    <div v-else-if="missing && removed" class="mx-auto max-w-3xl animate-fade-up px-4 py-8 sm:px-8 sm:py-12">
      <header class="mb-8 flex flex-col gap-2 border-b border-line pb-6">
        <h1 class="text-3xl font-semibold tracking-tight text-fg">{{ removed.title }}</h1>
        <p class="text-xs text-faint">Removed by {{ who(removed.deleted_by) }} {{ ago(removed.deleted_at) }}. Its past is kept, so it can come back.</p>
      </header>
      <DocHistory :project="String(route.params.project)" :doc="removed.id" @restored="restored" />
    </div>
    <NotFound v-else-if="missing && ready" :to="`/p/${route.params.project}/docs`" back="Back to the docs">No doc “{{ route.params.doc }}”</NotFound>
  </div>
  </div>
</template>
