<script setup lang="ts">
// `text` with each word of `q` marked where it appears, in any case (ORR-941): a search's matches, kept in sight.
const props = defineProps<{text: string, q?: string}>()
const parts = computed(() => {
    const words = (props.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/^#/, '')).filter(Boolean)
    if (!words.length) return [{text: props.text, hit: false}]
    const pattern = new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
    return props.text.split(pattern).filter(Boolean).map(text => ({text, hit: words.includes(text.toLowerCase())}))
})
</script>

<template>
  <span><template v-for="(part, i) in parts" :key="i"><mark v-if="part.hit" class="rounded-sm bg-amber-300/40 text-inherit dark:bg-amber-400/30">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span>
</template>
