<script setup lang="ts">
// Markdown drawn as a page (see `renderMarkdown`): docs, chunk summaries, issue descriptions, comments.
// Given `before`, what changed since is tinted.
const props = defineProps<{source: string, title?: string, before?: string}>()
const html = computed(() => renderMarkdown(props.source, props.title, props.before).html)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized in renderMarkdown -->
  <div class="doc" v-html="html" />
</template>
