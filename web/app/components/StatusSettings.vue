<script setup lang="ts">
import type {IssueStatus, Kind} from '#shared/roadmap'
import {KINDS, TINTS} from '#shared/roadmap'

// The Orrery's issue statuses on App settings, grouped by what they mean: rename one in place (Enter or
// leaving the field saves, Esc puts it back), recolour it, move it within its kind, add one to a kind, or
// remove one, its issues moving to another status. Each kind keeps at least one. Saved as the owner; every
// board follows live.
const {statuses} = useStatuses()
const {load} = useOwner()
const failed = ref('')
const busy = ref(false)
const KIND_LABEL: Record<Kind, {label: string, hint: string}> = {
    backlog: {label: 'Backlog', hint: 'someday, out of the active list'},
    todo: {label: 'Todo', hint: 'committed, not started'},
    started: {label: 'Started', hint: 'being worked on; shows on Now'},
    done: {label: 'Done', hint: 'shipped; counts towards progress'},
    canceled: {label: 'Canceled', hint: "won't be done; out of progress"},
}
const groups = computed(() => KINDS.map(kind => ({kind, statuses: statuses.value.filter(s => s.kind === kind)})))

async function call(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: Record<string, unknown>, query?: Record<string, string>) {
    busy.value = true
    failed.value = ''
    try {
        await $fetch(`/api/statuses${path}`, {method: method as 'POST', headers: {'Orrery-Actor': await load()}, body, query})
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    } finally {
        busy.value = false
    }
}
const patch = (status: IssueStatus, body: Record<string, unknown>) => call(`/${encodeURIComponent(status.id)}`, 'PATCH', body)

function rename(status: IssueStatus, event: Event) {
    const input = event.target as HTMLInputElement
    const name = input.value.trim()
    if (!name) input.value = status.name
    else if (name !== status.name) patch(status, {name})
}

/** Swaps it with its neighbour in the kind. */
function move(list: IssueStatus[], i: number, step: -1 | 1) {
    const [a, b] = [list[i], list[i + step]]
    if (!a || !b) return
    patch(a, {position: b.position}).then(ok => ok && patch(b, {position: a.position}))
}

const adding = ref<Kind | null>(null)
const newName = ref('')
async function add(kind: Kind) {
    const name = newName.value.trim()
    if (!name) return
    if (await call('', 'POST', {name, kind, color: 'slate'})) {
        newName.value = ''
        adding.value = null
    }
}

// Removing asks where its issues go: another status, the first other one of its kind to start with.
const removing = ref<string | null>(null)
const into = ref('')
function askRemove(status: IssueStatus) {
    removing.value = status.id
    into.value = statuses.value.find(s => s.id !== status.id && s.kind === status.kind)?.id ?? ''
}
async function remove(status: IssueStatus) {
    if (await call(`/${encodeURIComponent(status.id)}`, 'DELETE', undefined, {into: into.value})) removing.value = null
}

const field = 'h-7 rounded-md bg-transparent px-1.5 text-[13px] text-fg hover:bg-hover focus:bg-well focus:ring-1 focus:ring-accent-500/50 focus:outline-none'
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-for="{kind, statuses: list} in groups" :key="kind" class="flex flex-col rounded-xl bg-well/50 p-2 ring-1 ring-line">
      <div class="flex items-center gap-2 px-1.5 pb-1">
        <span class="text-xs font-medium text-fg">{{ KIND_LABEL[kind].label }}</span>
        <span class="text-xs text-faint">{{ KIND_LABEL[kind].hint }}</span>
        <UiButton variant="ghost" size="xs" class="ml-auto" @click="adding = kind; newName = ''">+ Add</UiButton>
      </div>
      <div v-for="(status, i) in list" :key="status.id" class="flex flex-col">
        <div class="group flex items-center gap-2 rounded-lg px-1.5 py-0.5 hover:bg-hover/60">
          <StatusIcon :column="status.id" />
          <input
              :value="status.name"
              :aria-label="`${status.name}'s name`"
              :class="[field, 'w-44 min-w-0']"
              maxlength="40"
              @blur="rename(status, $event)"
              @keydown.enter="($event.target as HTMLInputElement).blur()"
              @keydown.esc="($event.target as HTMLInputElement).value = status.name; ($event.target as HTMLInputElement).blur()"
          >
          <span class="font-mono text-[11px] text-faint">{{ status.id }}</span>
          <span class="ml-auto flex items-center gap-1">
            <button
                v-for="(color, name) in TINTS"
                :key="name"
                type="button"
                class="size-4 rounded-full ring-offset-1 ring-offset-panel transition-shadow"
                :class="status.color === name ? 'ring-2 ring-faint' : 'opacity-60 hover:opacity-100'"
                :style="{background: color}"
                :title="name"
                :aria-label="`Colour ${status.name} ${name}`"
                :disabled="busy"
                @click="patch(status, {color: name})"
            />
            <UiButton variant="ghost" size="xs" square :disabled="busy || i === 0" :aria-label="`Move ${status.name} up`" @click="move(list, i, -1)">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6" /></svg>
            </UiButton>
            <UiButton variant="ghost" size="xs" square :disabled="busy || i === list.length - 1" :aria-label="`Move ${status.name} down`" @click="move(list, i, 1)">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </UiButton>
            <UiButton
                variant="ghost"
                size="xs"
                square
                :disabled="busy || list.length === 1"
                :title="list.length === 1 ? `The only ${kind} status stays` : `Remove ${status.name}`"
                :aria-label="`Remove ${status.name}`"
                @click="askRemove(status)"
            >
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </UiButton>
          </span>
        </div>
        <div v-if="removing === status.id" class="flex flex-wrap items-center gap-2 px-8 py-1.5 text-xs text-muted">
          Remove {{ status.name }}; its issues and schedules move to
          <select v-model="into" aria-label="Move its issues to" class="h-7 rounded-md bg-well px-1.5 text-xs text-fg ring-1 ring-line focus:outline-none">
            <option v-for="s in statuses.filter(s => s.id !== status.id)" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <UiButton variant="danger" :disabled="busy" @click="remove(status)">Remove</UiButton>
          <UiButton @click="removing = null">Cancel</UiButton>
        </div>
      </div>
      <form v-if="adding === kind" class="flex items-center gap-2 px-1.5 pt-1" @submit.prevent="add(kind)">
        <input
            v-model="newName"
            :placeholder="`New ${KIND_LABEL[kind].label.toLowerCase()} status, e.g. ${kind === 'started' ? 'Blocked' : kind === 'canceled' ? 'Duplicate' : 'Triage'}`"
            aria-label="New status's name"
            maxlength="40"
            class="h-7 w-72 max-w-full rounded-md bg-well px-2 text-[13px] text-fg ring-1 ring-line focus:ring-accent-500/50 focus:outline-none"
            @keydown.esc="adding = null"
        >
        <UiButton type="submit" variant="primary" :disabled="busy || !newName.trim()">Add</UiButton>
      </form>
    </div>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
