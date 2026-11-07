<script setup lang="ts">
// The epics (ORR-895): each one piece of work across projects, with its progress and the projects it spans, in the
// order they're arranged in, a new one on top. A new one is named here; its issues join it from their own pages.
import type {Epic, Signal} from '#shared/roadmap'
import {shownId} from '#shared/roadmap'

const router = useRouter()
const {projects, ready, byId, sessions} = useRoadmaps()
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
// Right-clicking an epic (ORR-958): Focus on this, to a session orrery picks in each of its projects with open work
// (starting one where nobody's listening), Focus all on this when more than one listens, Open and Copy id.
const menu = ref<{epic: Epic, x: number, y: number} | null>(null)
const menuNote = ref('')
const menuFailed = ref('')
const menuBusy = ref(false)
const openParts = (epic: Epic) => epic.projects.filter(p => p.kinds.backlog + p.kinds.todo + p.kinds.started > 0).map(p => p.project)
const menuListening = computed(() => menu.value ? listeningOn(openParts(menu.value.epic), sessions.value).length : 0)
function openMenu(event: MouseEvent, epic: Epic) {
    event.preventDefault()
    menuNote.value = menuFailed.value = ''
    menu.value = {epic, x: event.clientX, y: event.clientY}
}
async function menuFocus(every: boolean) {
    if (!menu.value) return
    menuBusy.value = true
    menuFailed.value = ''
    try {
        const {signals} = await apiFetch<{signals: Signal[]}>(`/epics/${menu.value.epic.id}/focus`, {method: 'POST', body: every ? {session: '*'} : {start: true}})
        menuNote.value = signals.length === 1 ? `Sent to ${name(signals[0]?.project ?? '')}` : `Sent to ${signals.length} projects`
    } catch (error) {
        menuFailed.value = errorMessage(error, 'send')
    } finally {
        menuBusy.value = false
    }
}
async function menuCopy() {
    const epic = menu.value?.epic
    if (!epic) return
    const full = epic.full_id ?? shownId('epic', epic.id)
    if (await copyText(full)) menuNote.value = `Copied ${full}`
}
function menuOpen() {
    if (menu.value) router.push(epicPath(menu.value.epic.id))
    menu.value = null
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
          <NuxtLink :to="epicPath(epic.id)" class="flex flex-col gap-1.5 px-3 py-2 hover:tint" @contextmenu="openMenu($event, epic)">
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

  <UiContextMenu :at="menu" :label="menu ? `Actions for ${shownId('epic', menu.epic.id)}` : ''" width="w-64" @close="menu = null">
    <template v-if="menu">
      <div class="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs">
        <span class="font-mono text-faint">{{ shownId('epic', menu.epic.id) }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ menu.epic.title }}</span>
      </div>
      <div class="flex flex-col border-t border-line pt-1">
        <UiMenuItem
            v-if="openParts(menu.epic).length"
            :disabled="menuBusy"
            title="Ask a session in each project to work through the epic's open issues, most urgent first (starts one where nobody's listening)"
            @click="menuFocus(false)"
        >
          <svg class="size-3.5 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
          Focus on this
        </UiMenuItem>
        <UiMenuItem v-if="openParts(menu.epic).length && menuListening > 1" :disabled="menuBusy" @click="menuFocus(true)">
          <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
          Focus all {{ menuListening }} sessions on this
        </UiMenuItem>
        <UiMenuItem @click="menuCopy">
          <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
          Copy id
        </UiMenuItem>
        <UiMenuItem @click="menuOpen">
          <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
          Open
        </UiMenuItem>
      </div>
      <p v-if="menuFailed" class="px-2 pb-1.5 text-xs text-rose-700 dark:text-rose-400">{{ menuFailed }}</p>
      <p v-else-if="menuNote" class="px-2 pb-1.5 text-xs text-emerald-600 dark:text-emerald-400" role="status">{{ menuNote }}</p>
    </template>
  </UiContextMenu>
</template>
