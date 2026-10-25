<script setup lang="ts">
// Markdown drawn as a page (see `renderMarkdown`): docs, chunk summaries, issue descriptions, comments.
const props = defineProps<{source: string, title?: string}>()
const html = computed(() => renderMarkdown(props.source, props.title).html)
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized in renderMarkdown -->
  <div class="doc" v-html="html" />
</template>
