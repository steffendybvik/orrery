<script setup lang="ts">
import DOMPurify from 'dompurify'
import {marked} from 'marked'

// A doc's Markdown as HTML, cleaned of anything that could run, with links opening in a new tab.
// A leading `# Heading` that repeats the doc's title is left out, as the page already shows it.
const props = defineProps<{source: string, title?: string}>()
const html = computed(() => {
    const heading = /^\s*#\s+(.+)\n/.exec(props.source)
    const source = heading && heading[1]!.trim().toLowerCase() === props.title?.trim().toLowerCase() ? props.source.slice(heading[0].length) : props.source
    const raw = marked.parse(source, {async: false, gfm: true})
    const clean = DOMPurify.sanitize(raw, {USE_PROFILES: {html: true}})
    return clean.replace(/<a href="(https?:)/g, '<a target="_blank" rel="noopener noreferrer" href="$1')
})
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- sanitized above -->
  <div class="doc" v-html="html" />
</template>
