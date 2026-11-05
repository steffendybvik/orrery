<script setup lang="ts">
// The chat in a window of its own (ORR-938): ChatPane's Pop out opens it here, on the chat it showed (`?chat=`) or the
// project it'd start on (`?project=`, which the pane takes as the page's), filling the window. No sidebar or corner button: the window is the chat.
definePageMeta({layout: false})
useHead({title: 'Chat'})
const {load} = useOwner()
await callOnce('owner', load)

const route = useRoute()
const {chats, open, view, fetchChats} = useChat()
onMounted(async () => {
    open.value = true
    await fetchChats()
    const id = typeof route.query.chat === 'string' ? route.query.chat : null
    // `?project=` the pane reads as the page's project, as it would on that project's pages.
    if (id && chats.value.some(c => c.id === id)) view(id)
})
</script>

<template>
  <ChatPane standalone />
</template>
