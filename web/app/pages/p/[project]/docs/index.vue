<script setup lang="ts">
// A project's docs: overviews, decisions, how to run it. Written through the API.
const route = useRoute()
const router = useRouter()
const {byId, ready} = useRoadmaps()
const project = computed(() => byId(route.params.project as string))
// With docs to show, the first one opens, its list down the side.
watch(() => project.value?.docs[0]?.id, first => {
    if (first) router.replace(`/p/${project.value!.id}/docs/${first}`)
}, {immediate: true})
useHead(() => ({title: project.value ? `Docs · ${project.value.name} · Orrery` : 'Orrery'}))
const {docUnseen} = useUnseen()
</script>

<template>
  <PageHeader>
    <template v-if="project">
      <h1 class="truncate text-sm font-medium">{{ project.name }}</h1>
    </template>
  </PageHeader>

  <div class="min-h-0 flex-1 overflow-y-auto">
    <template v-if="project">
      <div v-if="project.docs.length" class="mx-auto flex max-w-3xl flex-col px-3 py-6 sm:px-6">
        <h2 class="label mb-2 px-3">Docs</h2>
        <NuxtLink
            v-for="doc in project.docs"
            :key="doc.id"
            data-nav
            :to="`/p/${project.id}/docs/${doc.id}`"
            class="group flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none hover:bg-hover focus-visible:bg-active"
            :class="docUnseen(project.id, doc) && 'unseen-row'"
        >
          <svg class="size-4 shrink-0 text-faint group-hover:text-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4M9 12h6M9 16h6" stroke-linecap="round" /></svg>
          <span class="min-w-0 flex-1 truncate text-[13px] text-fg" :class="docUnseen(project.id, doc) ? 'font-semibold' : ''">{{ doc.title }}</span>
          <span v-if="docUnseen(project.id, doc)" class="unseen-dot" title="Changed since you last opened it" />
          <svg v-if="doc.protected" class="size-3 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><title>Only the owner can delete it</title><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
          <PersonAvatar :name="doc.created_by" :size="16" />
          <span class="w-16 shrink-0 text-right text-xs text-faint" :title="doc.updated_at">{{ ago(doc.updated_at) }}</span>
        </NuxtLink>
      </div>
      <div v-else class="mx-auto flex max-w-xl flex-col gap-3 px-4 py-20 text-center">
        <p class="text-sm text-muted">{{ project.name }} has no docs yet.</p>
        <p class="text-xs text-faint">Ask Claude in its repo to add some, e.g. its README:</p>
        <pre class="overflow-x-auto rounded-xl bg-well p-3 text-left font-mono text-[11px] text-muted ring-1 ring-line">PUT /api/projects/{{ project.id }}/docs/readme
{"title": "README", "body": "# …markdown…"}</pre>
      </div>
    </template>
    <div v-else-if="ready" class="grid place-items-center px-4 py-24 text-sm text-muted">No project “{{ route.params.project }}”.</div>
  </div>
</template>
