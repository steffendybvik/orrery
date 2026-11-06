<script setup lang="ts">
// Markdown drawn as a page (see `renderMarkdown`): docs, milestone summaries, issue descriptions, comments.
// Given `before`, what changed since is tinted. `newTab`: links to orrery's own pages open in a new tab (the chat's).
const props = defineProps<{source: string, title?: string, before?: string, newTab?: boolean}>()
const html = computed(() => renderMarkdown(props.source, props.title, props.before, {newTab: props.newTab}).html)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized in renderMarkdown -->
  <div class="doc" v-html="html" />
</template>
