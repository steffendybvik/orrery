<script setup lang="ts">
import type {Comment} from '#shared/roadmap'

// Writing a comment on an issue, as the owner (so it's theirs: agents can't edit or delete it).
// Markdown works; ⌘↵ posts.
const props = defineProps<{project: string, issue: string}>()
const emit = defineEmits<{posted: [comment: Comment]}>()
const {load} = useOwner()
const body = ref('')
const posting = ref(false)
const failed = ref(false)

async function post() {
    const text = body.value.trim()
    if (!text || posting.value) return
    posting.value = true
    failed.value = false
    try {
        const comment = await $fetch<Comment>(`/api/projects/${encodeURIComponent(props.project)}/issues/${encodeURIComponent(props.issue)}/comments`, {
            method: 'POST', headers: {'Orrery-Actor': await load()}, body: {body: text},
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
</script>

<template>
  <form class="flex flex-col gap-2 rounded-xl bg-well p-2 ring-1 ring-line focus-within:ring-accent-500/50" @submit.prevent="post">
    <textarea
        v-model="body"
        rows="3"
        placeholder="Leave a comment… (Markdown works, ⌘↵ to post)"
        aria-label="Comment"
        class="min-h-20 resize-y bg-transparent px-2 py-1.5 text-[14px] leading-relaxed text-fg placeholder:text-faint focus:outline-none"
        @keydown.meta.enter.prevent="post"
        @keydown.ctrl.enter.prevent="post"
    />
    <div class="flex items-center gap-2 px-1">
      <span v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">Couldn't post. Is Orrery running?</span>
      <button
          type="submit"
          class="ml-auto h-7 rounded-md bg-accent-500 px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          :disabled="!body.trim() || posting"
      >{{ posting ? 'Posting…' : 'Comment' }}</button>
    </div>
  </form>
</template>
