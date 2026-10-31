<script setup lang="ts">
import type {Comment} from '#shared/roadmap'

// Writing a comment on an issue, as the owner (so it's theirs: agents can't edit or delete it), or, given
// `comment`, editing one of theirs (Esc cancels). Markdown works; ⌘↵ posts. An image pasted or dropped anywhere on the
// box, or picked, goes in as Markdown where the cursor is.
const props = defineProps<{project: string, issue: string, comment?: Comment}>()
const emit = defineEmits<{posted: [comment: Comment], cancel: []}>()
const body = ref(props.comment?.body ?? '')
const posting = ref(false)
const failed = ref(false)
const field = ref<HTMLTextAreaElement>()
const {uploading, failed: uploadError, upload, over, on: drop} = useImageUpload(body, field)

async function post() {
    const text = body.value.trim()
    if (!text || posting.value || uploading.value) return
    posting.value = true
    failed.value = false
    try {
        const comments = `/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/comments`
        const comment = await apiFetch<Comment>(props.comment ? `${comments}/${props.comment.id}` : comments, {
            method: props.comment ? 'PATCH' : 'POST', body: {body: text},
        })
        body.value = ''
        emit('posted', comment)
        // Answering may settle a comment waiting on the owner.
        useInbox().refresh()
    } catch {
        failed.value = true
    } finally {
        posting.value = false
    }
}
onMounted(() => {
    if (props.comment) field.value?.focus()
})
</script>

<template>
  <form
      class="relative flex flex-col gap-2 rounded-xl bg-well p-2 ring-1 ring-line focus-within:ring-accent-500/50"
      v-on="drop"
      @submit.prevent="post"
      @keydown.esc.stop.prevent="comment && emit('cancel')"
  >
    <ImageDropOverlay v-if="over" />
    <textarea
        ref="field"
        v-model="body"
        rows="3"
        :placeholder="comment ? 'Edit the comment… (⌘↵ to save, esc to cancel)' : 'Leave a comment… (Markdown works, paste or drop an image, ⌘↵ to post)'"
        :aria-label="comment ? 'Edit comment' : 'Comment'"
        class="min-h-20 resize-y bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
        @keydown.meta.enter.prevent="post"
        @keydown.ctrl.enter.prevent="post"
    />
    <div class="flex items-center gap-2 px-1">
      <ImageButton @picked="upload" />
      <span v-if="uploading" class="text-xs text-faint">Adding image…</span>
      <span v-else-if="uploadError" class="text-xs text-rose-700 dark:text-rose-400">{{ uploadError }}</span>
      <span v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">Couldn't {{ comment ? 'save' : 'post' }}. Is orrery running?</span>
      <UiButton v-if="comment" class="ml-auto" :disabled="posting" @click="emit('cancel')">Cancel <KeyHint>esc</KeyHint></UiButton>
      <UiButton
          type="submit"
          variant="primary"
          :class="!comment && 'ml-auto'"
          :disabled="!body.trim() || posting || !!uploading"
      >{{ comment ? posting ? 'Saving…' : 'Save' : posting ? 'Posting…' : 'Comment' }}</UiButton>
    </div>
  </form>
</template>
