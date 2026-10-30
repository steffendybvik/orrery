<script setup lang="ts">
import type {Doc, DocRevision, DocRevisionSummary} from '#shared/roadmap'

// A doc's past (ORR-675): its revisions, newest first, and what the one picked changed from the one before. Restoring
// saves it as a new revision, so that can be undone too; a removed doc's last text brings it back.
const props = defineProps<{project: string, doc: string, updatedAt?: string}>()
const emit = defineEmits<{restored: [doc: Doc]}>()
const {who, load} = useOwner()

const base = computed(() => `/api/projects/${encodeURIComponent(props.project)}/docs/${encodeURIComponent(props.doc)}/revisions`)
const revisions = ref<DocRevisionSummary[] | null>(null)
const picked = ref<number | null>(null)
const failed = ref('')
// Read again as the doc changes, staying on the one picked. A reply after you've moved on is let go.
watch([base, () => props.updatedAt], async (_, __, onCleanup) => {
    let left = false
    onCleanup(() => left = true)
    try {
        const list = await $fetch<DocRevisionSummary[]>(base.value)
        if (left) return
        revisions.value = list
        if (!list.some(r => r.id === picked.value)) picked.value = list[0]?.id ?? null
    } catch (error) {
        if (!left) failed.value = errorMessage(error)
    }
}, {immediate: true})

const at = computed(() => revisions.value?.findIndex(r => r.id === picked.value) ?? -1)
const newest = computed(() => revisions.value?.[0])
const older = computed(() => revisions.value?.[at.value + 1])

// The picked revision and the one before it, with their text; a revision never changes, so each is read once.
const texts = new Map<string, Promise<DocRevision>>()
function text(id: number): Promise<DocRevision> {
    const url = `${base.value}/${id}`
    let found = texts.get(url)
    if (!found) {
        found = $fetch<DocRevision>(url)
        found.catch(() => texts.delete(url))
        texts.set(url, found)
    }
    return found
}
const shown = ref<{to: DocRevision, from: DocRevision | null} | null>(null)
watch([picked, older], async ([id, before], _, onCleanup) => {
    let left = false
    onCleanup(() => left = true)
    if (id === null) return
    try {
        const [to, from] = await Promise.all([text(id), before ? text(before.id) : null])
        if (!left) shown.value = {to, from}
    } catch (error) {
        if (!left) failed.value = errorMessage(error)
    }
}, {immediate: true})

const label = (revision: DocRevisionSummary) => revision.deleted ? 'Removed' : revision.id === revisions.value?.at(-1)?.id ? 'First version' : 'Edited'

// The newest is what the doc already says, unless it's the removal: that one brings it back.
const canRestore = computed(() => !!shown.value && (shown.value.to.id !== newest.value?.id || shown.value.to.deleted))
const gone = computed(() => !!newest.value?.deleted)
const asking = ref(false)
const busy = ref(false)
watch(picked, () => asking.value = false)
async function restore() {
    if (picked.value === null) return
    busy.value = true
    failed.value = ''
    try {
        emit('restored', await $fetch<Doc>(`${base.value}/${picked.value}/restore`, {method: 'POST', headers: {'Orrery-Actor': await load()}}))
    } catch (error) {
        failed.value = errorMessage(error, 'restore')
    } finally {
        busy.value = false
        asking.value = false
    }
}
</script>

<template>
  <section class="flex flex-col gap-4" aria-label="History">
    <ul v-if="revisions" class="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-xl bg-well p-1 ring-1 ring-line">
      <li v-for="revision in revisions" :key="revision.id">
        <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] outline-none transition-colors hover:bg-hover focus-visible:bg-active"
            :class="revision.id === picked && 'bg-active'"
            :aria-current="revision.id === picked"
            @click="picked = revision.id"
        >
          <PersonAvatar :name="revision.created_by" :size="16" />
          <span class="min-w-0 flex-1 truncate" :class="revision.deleted ? 'text-rose-600 dark:text-rose-400' : 'text-fg'">
            {{ label(revision) }}<span class="text-muted"> by {{ who(revision.created_by) }}</span><span v-if="revision.session_name" class="text-faint"> · {{ revision.session_name }}</span>
          </span>
          <span v-if="revision.id === newest?.id && !revision.deleted" class="shrink-0 text-xs text-accent-600 dark:text-accent-400">Current</span>
          <span class="shrink-0 text-xs text-faint" :title="revision.created_at">{{ ago(revision.created_at) }}</span>
        </button>
      </li>
    </ul>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    <template v-if="shown">
      <div class="flex min-h-7 items-center justify-between gap-3">
        <p class="min-w-0 truncate text-sm font-medium text-fg">
          <template v-if="shown.from && shown.from.title !== shown.to.title"><span class="font-normal text-muted line-through decoration-faint">{{ shown.from.title }}</span> → </template>{{ shown.to.title }}
        </p>
        <template v-if="canRestore">
          <UiConfirm v-if="asking" inline class="shrink-0 text-xs" :action="gone ? 'Bring back' : 'Restore'" :busy-action="gone ? 'Bringing back…' : 'Restoring…'" :busy="busy" @confirm="restore" @cancel="asking = false">
            {{ gone ? 'Bring it back with this text?' : 'Restore this version?' }}
          </UiConfirm>
          <UiButton v-else class="shrink-0" :variant="gone ? 'primary' : 'secondary'" @click="asking = true">{{ gone ? 'Bring it back' : 'Restore this version' }}</UiButton>
        </template>
      </div>
      <p v-if="shown.to.deleted" class="text-xs text-faint">The doc was removed here. This is the text it had.</p>
      <p v-else-if="shown.from && shown.from.body === shown.to.body" class="text-xs text-faint">{{ shown.from.title === shown.to.title ? 'The same text as the version before.' : 'Only the title changed.' }}</p>
      <div v-if="shown.to.deleted" class="max-h-[32rem] overflow-auto rounded-lg bg-panel p-2 font-mono text-xs break-words whitespace-pre-wrap text-fg ring-1 ring-line" tabindex="0">{{ shown.to.body }}</div>
      <DocDiff v-else-if="!shown.from || shown.from.body !== shown.to.body" :from="shown.from?.body ?? ''" :to="shown.to.body" class="max-h-[32rem]" />
    </template>
  </section>
</template>
