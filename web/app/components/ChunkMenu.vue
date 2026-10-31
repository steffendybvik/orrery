<script setup lang="ts">
import type {Priority} from '#shared/roadmap'
import {PRIORITIES, fullId} from '#shared/roadmap'

// Right-clicking a chunk's card on the roadmap: set its priority, ask the Claude sessions to work through
// it, start a new issue in it, copy its id, open or remove it (its issues stay, in no chunk), all as the
// owner. The roadmap updates live once a change is saved. Esc or a click outside closes it. No chunk
// (`none`, the issues in none) isn't a chunk of its own, so it has no priority, id or removing.
const {target, close} = useChunkMenu()
const {byId, sessions} = useRoadmaps()
const router = useRouter()

const project = computed(() => byId(target.value?.project))
const chunk = computed(() => project.value?.board.chunks.find(c => (c.id || 'none') === target.value?.chunk))
const listening = computed(() => (sessions.value[target.value?.project ?? ''] ?? []).filter(s => s.listening).length)

const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const note = ref('')

watch(target, () => {
    failed.value = ''
    confirming.value = false
    note.value = ''
})
// Closed if the chunk goes away (removed elsewhere).
watch(chunk, now => target.value && !now && close())

const api = computed(() => target.value ? `/projects/${encodeURIComponent(target.value.project)}/chunks/${encodeURIComponent(target.value.chunk)}` : '')

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

const setPriority = (priority: Priority | null) => send('', 'PATCH', {priority})
// Aimed at no session, orrery picks one (the one already on it, else an idle one); `every` asks them all.
const focus = (every = false) => send('/focus', 'POST', every ? {session: '*'} : {}, () => {
    note.value = every ? `Sent to all ${listening.value} sessions` : listening.value === 1 ? 'Sent to the listening session' : 'Sent to one session, the first free'
})
const remove = () => send('', 'DELETE')

function newIssue() {
    if (!target.value) return
    useNewIssue().open(target.value.project, chunk.value?.id || undefined)
    close()
}

function openChunk() {
    if (!target.value) return
    router.push(chunkPath(target.value.project, chunk.value?.id ?? ''))
    close()
}

async function copyId() {
    if (!chunk.value || !project.value) return
    const full = fullId('chunk', chunk.value.id, project.value.uid)
    if (await copyText(full)) note.value = `Copied ${full}`
}


const pick = 'grid size-7 place-items-center rounded-md ring-1 hover:bg-hover disabled:opacity-50'
</script>

<template>
  <UiContextMenu :at="chunk && project ? target : null" :label="chunk?.id ? `Actions for chunk ${chunk.id}` : 'Actions for the issues in no chunk'" width="w-64" @close="close">
    <template v-if="chunk && project">
      <div class="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs">
        <span v-if="chunk.id" class="font-mono text-faint">{{ chunk.id }}</span>
        <span class="min-w-0 flex-1 truncate text-muted" :class="!chunk.id && 'italic'">{{ chunk.title }}</span>
      </div>

      <template v-if="!confirming">
        <div v-if="chunk.id" class="flex flex-col gap-1 border-t border-line px-2 pt-2 pb-1">
          <span class="label">Priority</span>
          <div class="flex gap-1">
            <button
                v-for="p in [null, ...PRIORITIES]"
                :key="p ?? 'none'"
                type="button"
                :class="[pick, (chunk.priority ?? null) === p ? 'bg-active ring-faint/50' : 'ring-transparent']"
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
          <UiMenuItem v-if="listening && !isClosed(chunk.kind)" :disabled="busy" @click="focus()">
            <svg class="size-3.5 text-accent-fill" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
            Ask {{ listening === 1 ? 'the session' : 'a session' }} to work through it
          </UiMenuItem>
          <UiMenuItem v-if="listening > 1 && !isClosed(chunk.kind)" :disabled="busy" @click="focus(true)">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
            Ask all {{ listening }} sessions to work through it
          </UiMenuItem>
          <UiMenuItem @click="newIssue">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
            New issue in it
          </UiMenuItem>
          <UiMenuItem v-if="chunk.id" @click="copyId">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
            Copy id
          </UiMenuItem>
          <UiMenuItem @click="openChunk">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
            Open
          </UiMenuItem>
          <UiMenuItem v-if="chunk.id" danger :disabled="busy" @click="confirming = true">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            Remove…
          </UiMenuItem>
        </div>
      </template>

      <UiConfirm v-else class="border-t border-line p-2" :busy="busy" @confirm="remove" @cancel="confirming = false">
        Remove chunk {{ chunk.id }}? Its {{ chunk.tasks.length }} {{ chunk.tasks.length === 1 ? 'issue stays' : 'issues stay' }}, in no chunk.
      </UiConfirm>

      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
      <p v-else-if="note" class="px-2 pb-1.5 text-xs text-emerald-600 dark:text-emerald-400">{{ note }}</p>
    </template>
  </UiContextMenu>
</template>
