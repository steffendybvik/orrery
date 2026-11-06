<script setup lang="ts">
// The epics (ORR-895): each one piece of work across projects, with its progress and the projects it spans, in the
// order they're arranged in, a new one on top. A new one is named here; its issues join it from their own pages.
import {shownId} from '#shared/roadmap'

const router = useRouter()
const {projects, ready, byId} = useRoadmaps()
const {epics, failed, load} = useLiveEpics()
useHead({title: 'Epics · orrery'})
const name = (id: string) => byId(id)?.name ?? id
const issues = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`

const adding = ref(false)
const title = ref('')
const saving = ref(false)
const saveFailed = ref('')
const input = ref<HTMLInputElement | null>(null)
function startAdding() {
    adding.value = true
    nextTick(() => input.value?.focus())
}
async function add() {
    const next = title.value.trim()
    if (!next) return
    saving.value = true
    saveFailed.value = ''
    try {
        const epic = await apiFetch<{id: number}>('/epics', {method: 'POST', body: {title: next}})
        title.value = ''
        adding.value = false
        await load()
        router.push(epicPath(epic.id))
    } catch (error) {
        saveFailed.value = errorMessage(error)
    } finally {
        saving.value = false
    }
}
</script>

<template>
  <PageHeader>
    <SectionIcon section="epics" class="size-4 shrink-0 text-accent-fill" />
    <h1 class="truncate text-sm font-medium">Epics</h1>
  </PageHeader>

  <ViewToolbar>
    <span v-if="epics" class="text-xs text-muted">{{ epics.length }} {{ epics.length === 1 ? 'epic' : 'epics' }}</span>
    <span v-if="failed && epics" class="text-xs text-rose-700 dark:text-rose-400">Couldn't read them again: {{ failed }}</span>
    <UiButton v-if="!adding" class="ml-auto" size="xs" @click="startAdding">New epic</UiButton>
  </ViewToolbar>

  <div class="clear-agent min-h-0 flex-1 overflow-y-auto">
    <EmptyProjects v-if="ready && !projects.length" />
    <UiLoading v-else-if="!epics" :failed="failed" what="the epics" @retry="load" />
    <div v-else class="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-6">
      <form v-if="adding" class="flex items-center gap-2" @submit.prevent="add" @keydown.esc.stop.prevent="adding = false">
        <input
            ref="input"
            v-model="title"
            aria-label="The new epic's title"
            placeholder="Checkout tracking and attribution"
            class="h-8 min-w-0 flex-1 rounded-md bg-well px-2.5 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
            :disabled="saving"
        >
        <UiButton :disabled="saving" @click="adding = false">Cancel</UiButton>
        <UiButton type="submit" variant="primary" :disabled="saving || !title.trim()"><UiBusy :busy="saving" label="Adding…">Add</UiBusy></UiButton>
      </form>
      <p v-if="saveFailed" class="text-xs text-rose-700 dark:text-rose-400">{{ saveFailed }}</p>

      <ul v-if="epics.length" class="overflow-hidden rounded-xl border border-line dark:bg-panel" aria-label="Epics">
        <li v-for="epic in epics" :key="epic.id" class="border-b border-line last:border-b-0">
          <NuxtLink :to="epicPath(epic.id)" class="flex flex-col gap-1.5 px-3 py-2 hover:tint">
            <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span class="font-mono text-xs text-faint">{{ shownId('epic', epic.id) }}</span>
              <span class="min-w-0 truncate text-[13px] font-medium text-fg">{{ epic.title }}</span>
              <span class="ml-auto flex items-center gap-3 text-xs text-faint">
                <span>{{ issues(epic.issues) }}</span>
                <ProgressRing :kinds="epic.kinds" />
              </span>
            </span>
            <span v-if="epic.projects.length" class="flex flex-col gap-1 border-l border-line pl-3">
              <span v-for="part in epic.projects" :key="part.project" class="flex items-center gap-3 text-xs text-muted">
                <span class="min-w-0 truncate">{{ name(part.project) }}</span>
                <span class="ml-auto shrink-0 text-faint">{{ issues(part.issues) }}</span>
                <ProgressRing :kinds="part.kinds" />
              </span>
            </span>
          </NuxtLink>
        </li>
      </ul>
      <p v-else-if="!adding" class="rounded-xl border border-dashed border-line px-4 py-10 text-center text-[13px] leading-relaxed text-muted">
        No epics yet. An epic is one piece of work across projects, such as a feature with a part in each repo.
        <button type="button" class="text-fg underline underline-offset-2" @click="startAdding">Add one</button>,
        then pick it under Epic on each issue's page.
      </p>
    </div>
  </div>
</template>
