<script setup lang="ts">
import type {ThreadComment} from '#shared/roadmap'

// The comments on a milestone's or an epic's page (ORR-977), at `url`: words, as an issue's look, oldest first, with the
// box for a new one. The owner's own edit and come out in place. They're read again when `reload` changes (the project,
// or the epic, changed), so another's comment shows up live.
const props = defineProps<{url: string, reload?: unknown}>()
const {who} = useOwner()

const comments = ref<ThreadComment[]>([])
const failed = ref(false)
watch(() => [props.url, props.reload] as const, async ([url], _, onCleanup) => {
    let stale = false
    onCleanup(() => stale = true)
    try {
        const read = await apiFetch<ThreadComment[]>(url)
        if (!stale) [comments.value, failed.value] = [read, false]
    } catch {
        if (!stale) failed.value = true
    }
}, {immediate: true})

const editing = ref<number | null>(null)
const removing = ref<{id: number, busy?: boolean, failed?: string} | null>(null)
function posted(comment: ThreadComment) {
    comments.value = [...comments.value.filter(c => c.id !== comment.id), comment].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
    editing.value = null
}
async function remove(id: number) {
    removing.value = {id, busy: true}
    try {
        await apiFetch(`${props.url}/${id}`, {method: 'DELETE'})
        comments.value = comments.value.filter(c => c.id !== id)
        removing.value = null
    } catch (error) {
        removing.value = {id, failed: errorMessage(error, 'delete')}
    }
}
</script>

<template>
  <section class="flex flex-col gap-3" aria-label="Comments">
    <h2 class="label">Comments</h2>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">Couldn't read the comments. Is orrery running?</p>
    <ol v-if="comments.length" class="flex flex-col gap-5">
      <li v-for="comment in comments" :id="`comment-${comment.id}`" :key="comment.id" class="group flex scroll-mt-20 flex-col gap-1.5">
        <div class="flex items-center gap-2 text-xs">
          <PersonAvatar :name="comment.created_by" :size="20" />
          <span class="font-medium text-fg">{{ who(comment.created_by, comment.session_name) }}</span>
          <span class="text-faint" :title="comment.created_at">{{ ago(comment.created_at) }}{{ comment.updated_at !== comment.created_at ? ' · edited' : '' }}</span>
          <UiConfirm
              v-if="removing?.id === comment.id"
              inline
              size="xs"
              class="ml-auto"
              action="Delete"
              busy-action="Deleting…"
              :busy="removing.busy"
              @confirm="remove(comment.id)"
              @cancel="removing = null"
          >
            Delete the comment?
          </UiConfirm>
          <span v-else class="ml-auto flex items-center gap-0.5 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100">
            <template v-if="comment.protected && editing !== comment.id">
              <UiButton variant="ghost" size="xs" @click="editing = comment.id">Edit</UiButton>
              <UiButton variant="danger-ghost" size="xs" @click="removing = {id: comment.id}">Delete</UiButton>
            </template>
            <CopyButton :text="comment.body" name="the comment" />
          </span>
        </div>
        <p v-if="removing?.id === comment.id && removing.failed" class="text-xs text-rose-700 dark:text-rose-400">{{ removing.failed }}</p>
        <CommentBox v-if="editing === comment.id" :url="url" :comment="comment" @posted="posted" @cancel="editing = null" />
        <div v-else class="rounded-xl bg-well px-4 py-3 ring-1 ring-line"><MarkdownView :source="comment.body" class="text-[14px] leading-6" /></div>
      </li>
    </ol>
    <CommentBox :url="url" @posted="posted" />
  </section>
</template>
