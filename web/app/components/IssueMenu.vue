<script setup lang="ts">
import type {Column, Priority} from '#shared/roadmap'
import {PRIORITIES} from '#shared/roadmap'

// Right-clicking an issue's row or card: move it to a column, set its priority, put it in a chunk, ask
// the Claude sessions to focus on it, copy its id, open or remove it, all as the owner, without
// opening its page. The board updates live once a change is saved. Esc or a click outside closes it.
const {target, close} = useIssueMenu()
const {byId, sessions} = useRoadmaps()
const {load} = useOwner()
const {open: openIssue} = useIssueLink()

const project = computed(() => byId(target.value?.project))
const found = computed(() => target.value ? findIssue(project.value, target.value.issue) : null)
const issue = computed(() => found.value?.issue)
const chunks = computed(() => project.value?.board.chunks.filter(c => c.id) ?? [])
const listening = computed(() => (sessions.value[target.value?.project ?? ''] ?? []).filter(s => s.listening).length)
const {places: WHERE} = useStatuses()

const menu = ref<HTMLElement | null>(null)
const place = ref({left: 0, top: 0})
const busy = ref(false)
const failed = ref('')
const confirming = ref(false)
const choosingChunk = ref(false)
const note = ref('')

watch(target, now => {
    failed.value = ''
    confirming.value = false
    choosingChunk.value = false
    note.value = ''
    if (!now) return
    place.value = {left: now.x, top: now.y}
    // Kept inside the window once it's drawn and its size is known.
    nextTick(() => {
        const box = menu.value?.getBoundingClientRect()
        if (!box) return
        place.value = {
            left: Math.max(8, Math.min(now.x, window.innerWidth - box.width - 8)),
            top: Math.max(8, Math.min(now.y, window.innerHeight - box.height - 8)),
        }
        menu.value?.focus()
    })
})
// Closed if the issue goes away (removed elsewhere).
watch(issue, now => target.value && !now && close())

const api = computed(() => target.value ? `/api/projects/${encodeURIComponent(target.value.project)}/issues/${encodeURIComponent(target.value.issue)}` : '')

async function send(path: string, method: 'PATCH' | 'POST' | 'DELETE', body?: Record<string, unknown>, then?: () => void) {
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`${api.value}${path}`, {method, headers: {'Orrery-Actor': await load()}, body})
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
const focus = () => send('/focus', 'POST', {}, () => {
    note.value = `Sent to ${listening.value === 1 ? 'the listening session' : `${listening.value} sessions`}`
})
const remove = () => send('', 'DELETE')

async function copyId() {
    if (issue.value && await copyText(issue.value.id)) note.value = `Copied ${issue.value.id}`
}

function onOutside(event: PointerEvent) {
    if (!menu.value?.contains(event.target as Node)) close()
}
watch(() => !!target.value, isOpen => {
    if (isOpen) {
        document.addEventListener('pointerdown', onOutside, true)
        window.addEventListener('blur', close)
        window.addEventListener('resize', close)
    } else {
        document.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('blur', close)
        window.removeEventListener('resize', close)
    }
})
onBeforeUnmount(() => {
    document.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('blur', close)
    window.removeEventListener('resize', close)
})

const item = 'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-fg hover:bg-hover disabled:opacity-50'
const pick = 'grid size-7 place-items-center rounded-md ring-1 hover:bg-hover disabled:opacity-50'
</script>

<template>
  <Teleport to="body">
    <div
        v-if="target && issue && project"
        ref="menu"
        class="glass fixed z-50 flex w-64 animate-fade-up flex-col gap-1 rounded-xl p-1 outline-none"
        :style="{left: `${place.left}px`, top: `${place.top}px`}"
        role="menu"
        :aria-label="`Actions for ${issue.id}`"
        tabindex="-1"
        @keydown.esc.stop="close"
        @contextmenu.prevent
    >
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
          <button v-if="!found?.parents.length" type="button" :class="item" :disabled="busy" @click="choosingChunk = true">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /></svg>
            <span class="flex-1">Move to chunk</span>
            <span class="max-w-24 truncate text-xs text-faint">{{ found?.chunk.id ? found.chunk.title : 'None' }}</span>
          </button>
          <button v-if="listening && !isClosed(issue.kind)" type="button" :class="item" :disabled="busy" @click="focus">
            <svg class="size-3.5 text-accent-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /></svg>
            Ask {{ listening === 1 ? 'the session' : `all ${listening} sessions` }} to focus on it
          </button>
          <button type="button" :class="item" @click="copyId">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
            Copy id
          </button>
          <button type="button" :class="item" @click="openIssue(project.id, issue.id); close()">
            <svg class="size-3.5 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
            Open
          </button>
          <button type="button" :class="[item, 'text-rose-600 hover:bg-rose-500/10 dark:text-rose-400']" :disabled="busy" @click="confirming = true">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
            Remove…
          </button>
        </div>
      </template>

      <div v-else-if="choosingChunk" class="flex max-h-64 flex-col overflow-y-auto border-t border-line pt-1">
        <button type="button" :class="[item, 'text-muted']" @click="choosingChunk = false">‹ Back</button>
        <button
            v-for="c in [{id: '', title: 'No chunk'}, ...chunks]"
            :key="c.id"
            type="button"
            :class="[item, found?.chunk.id === c.id ? 'bg-active' : '', !c.id ? 'text-muted italic' : '']"
            :disabled="busy"
            @click="setChunk(c.id || null)"
        >
          <span class="flex-1 truncate">{{ c.title }}</span>
        </button>
      </div>

      <div v-else class="flex flex-col gap-2 border-t border-line p-2 text-xs">
        <p class="text-muted">Remove {{ issue.id }}<template v-if="issue.tasks.length"> and its sub-issues</template>, with its comments?</p>
        <div class="flex gap-2">
          <button type="button" class="h-7 flex-1 rounded-md bg-rose-600 font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="busy" @click="remove">{{ busy ? 'Removing…' : 'Remove' }}</button>
          <button type="button" class="h-7 flex-1 rounded-md text-muted ring-1 ring-line hover:bg-hover hover:text-fg" :disabled="busy" @click="confirming = false">Cancel</button>
        </div>
      </div>

      <p v-if="failed" class="px-2 pb-1.5 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
      <p v-else-if="note" class="px-2 pb-1.5 text-xs text-emerald-600 dark:text-emerald-400">{{ note }}</p>
    </div>
  </Teleport>
</template>
