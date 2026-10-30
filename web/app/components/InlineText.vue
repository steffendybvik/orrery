<script setup lang="ts">
// Text with inline `code`, **bold** and [links](url), the markup roadmap notes use. A link to a
// web page opens it; a link into the repo (`ROADMAP.md#…`) only shows its text. The rest is plain text.
const props = defineProps<{text: string}>()

const parts = computed(() => props.text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\))/g).filter(Boolean).map(part => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return {kind: 'code', text: part.slice(1, -1)}
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return {kind: 'bold', text: part.slice(2, -2)}
    const [, text, href] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part) ?? []
    if (text && href) return {kind: /^https?:\/\//.test(href) ? 'link' : 'ref', text, href}
    return {kind: 'text', text: part}
}))
</script>

<template>
  <template v-for="(part, i) in parts" :key="i">
    <code v-if="part.kind === 'code'" class="rounded bg-well px-1 py-px font-mono text-[0.9em] text-fg ring-1 ring-line">{{ part.text }}</code>
    <strong v-else-if="part.kind === 'bold'" class="font-semibold text-fg">{{ part.text }}</strong>
    <a v-else-if="part.kind === 'link'" :href="part.href" target="_blank" rel="noopener noreferrer" class="text-accent-700 underline decoration-accent-500/40 underline-offset-2 hover:decoration-accent-500 dark:text-accent-400" @click.stop>{{ part.text }}</a>
    <span v-else-if="part.kind === 'ref'" class="text-fg" :title="part.href">{{ part.text }}</span>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
