<script setup lang="ts">
import type {Column, Priority} from '#shared/roadmap'
import {PRIORITIES, fullId} from '#shared/roadmap'

// Right-clicking an issue's row or card: move it to a column, set its priority, put it in a chunk, ask
// the Claude sessions to focus on it, copy its id, open or remove it, all as the owner, without
// opening its page. The board updates live once a change is saved. Esc or a click outside closes it.
const {target, close} = useIssueMenu()
const {byId, sessions} = useRoadmaps()
const {open: openIssue} = useIssueLink()

const project = computed(() => byId(target.value?.project))
const found = computed(() => target.value ? findIssue(project.value, target.value.issue) : null)
const issue = computed(() => found.value?.issue)
const chunks = computed(() => project.value?.board.chunks.filter(c => c.id) ?? [])
const listening = computed(() => (sessions.value[target.value?.project ?? ''] ?? []).filter(s => s.listening).length)
const {places: WHERE} = useStatuses()

const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const choosingChunk = ref(false)
const note = ref('')

watch(target, () => {
    failed.value = ''
    confirming.value = false
    choosingChunk.value = false
    note.value = ''
})
// Closed if the issue goes away (removed elsewhere).
watch(issue, now => target.value && !now && close())

const api = computed(() => target.value ? `/projects/${encodeURIComponent(target.value.project)}/issues/${encodeURIComponent(target.value.issue)}` : '')

async function send(path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: Record<string, unknown>, then?: () => void) {
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`${api.value}${path}`, {method, body})
        if (then) then()
        else close()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}

const moveTo = (column: Column) => send('', 'PATCH', columnPatch(column, issue.value?.proposal))
const setPriority = (priority: Priority | null) => send('', 'PATCH', {priority})
const setChunk = (chunk: string | null) => send('', 'PATCH', {chunk})
// Aimed at no session, orrery picks one (the one already on it, else an idle one). Only a chunk can go to them all (ORR-681).
const focus = () => send('/focus', 'POST', {}, () => {
    note.value = listening.value === 1 ? 'Sent to the listening session' : 'Sent to one session, the first free'
})
const remove = () => send('', 'DELETE')

async function copyId() {
    if (!issue.value || !project.value) return
    const full = fullId('issue', issue.value.id, project.value.uid)
    if (await copyText(full)) note.value = `Copied ${full}`
}


const pick = 'grid size-7 place-items-center rounded-md ring-1 hover:bg-hover disabled:opacity-50'
</script>

<template>
  <UiContextMenu :at="issue && project ? target : null" :label="`Actions for ${issue?.id}`" width="w-64" @close="close">
    <template v-if="issue && project">
      <div class="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs">
        <span class="font-mono text-faint">{{ issue.id }}</span>
        <span class="min-w-0 flex-1 truncate text-muted">{{ issue.title }}</span>
      </div>

      <template v-if="!confirming && !choosingChunk">
        <div v-if="!issue.tasks.length" class="flex flex-col gap-1 border-t border-line px-2 pt-2 pb-1">
          <span class="label">Move to</span>
          <div class="flex gap-1">
            <button
                v-for="{id: column, label, kind} in WHERE"
                :key="column"
                type="button"
                :class="[pick, issue.column === column ? 'bg-active ring-faint/50' : 'ring-transparent']"
                :title="label"
                :aria-label="`Move to ${label}`"
                :disabled="busy"
                @click="moveTo(column)"
            >
              <StatusIcon :column="column" :progress="kind === 'started' ? 0.5 : 0" />
            </button>
          </div>
        </div>
        <div class="flex flex-col gap-1 border-t border-line px-2 pt-2 pb-1">
          <span class="label">Priority</span>
          <div class="flex gap-1">
            <button
                v-for="p in [null, ...PRIORITIES]"
                :key="p ?? 'none'"
                type="button"
                :class="[pick, (issue.priority ?? null) === p ? 'bg-active ring-faint/50' : 'ring-transparent']"
                :title="p ? `${p} · ${PRIORITY_LABEL[p]}` : 'No priority'"
                :aria-label="p ? `Priority ${p}` : 'No priority'"
                :disabled="busy"
                @click="setPriority(p)"
            >
              <PriorityIcon :priority="p ?? undefined" />
            </button>
          </div>
        </div>

        <div class="flex flex-col border-t border-line pt-1">
          <UiMenuItem v-if="!found?.parents.length" :disabled="busy" @click="choosingChunk = true">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /></svg>
            <span class="flex-1">Move to chunk</span>
            <span class="max-w-24 truncate text-xs text-faint">{{ found?.chunk.id ? found.chunk.title : 'None' }}</span>
          </UiMenuItem>
          <UiMenuItem v-if="listening && !isClosed(issue.kind)" :disabled="busy" @click="focus()">
            <svg class="size-3.5 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
            Ask {{ listening === 1 ? 'the session' : 'a session' }} to focus on it
          </UiMenuItem>
          <UiMenuItem @click="copyId">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
            Copy id
          </UiMenuItem>
          <UiMenuItem @click="openIssue(project.id, issue.id); close()">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
            Open
          </UiMenuItem>
          <UiMenuItem danger :disabled="busy" @click="confirming = true">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            Remove…
          </UiMenuItem>
        </div>
      </template>

      <div v-else-if="choosingChunk" class="flex max-h-64 flex-col overflow-y-auto border-t border-line pt-1">
        <UiMenuItem muted @click="choosingChunk = false">‹ Back</UiMenuItem>
        <UiMenuItem
            v-for="c in [{id: '', title: 'No chunk'}, ...chunks]"
            :key="c.id"
            :active="found?.chunk.id === c.id"
            :muted="!c.id"
            :class="!c.id && 'italic'"
            :disabled="busy"
            @click="setChunk(c.id || null)"
        >
          <span class="flex-1 truncate">{{ c.title }}</span>
        </UiMenuItem>
      </div>

      <UiConfirm v-else class="border-t border-line p-2" :busy="busy" @confirm="remove" @cancel="confirming = false">
        Remove {{ issue.id }}<template v-if="issue.tasks.length"> and its sub-issues</template>, with its comments?
      </UiConfirm>

      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
      <p v-else-if="note" class="px-2 pb-1.5 text-xs text-emerald-600 dark:text-emerald-400">{{ note }}</p>
    </template>
  </UiContextMenu>
</template>
