<script setup lang="ts">
import type {Heading} from '~/utils/markdown'

// A doc's table of contents: its h2/h3 headings, the one being read marked as the page scrolls.
// `root` is the element that scrolls.
const props = defineProps<{headings: Heading[], root: HTMLElement | null}>()
const current = ref<string | null>(null)

function follow() {
    if (!props.root) return
    const top = props.root.getBoundingClientRect().top + 96
    let reading: string | null = props.headings[0]?.id ?? null
    for (const heading of props.headings) {
        const element = document.getElementById(heading.id)
        if (element && element.getBoundingClientRect().top <= top) reading = heading.id
    }
    // At the bottom, the last heading may never reach the top: it's the one being read.
    const {scrollTop, clientHeight, scrollHeight} = props.root
    if (scrollTop > 0 && scrollTop + clientHeight >= scrollHeight - 2) reading = props.headings.at(-1)?.id ?? reading
    current.value = reading
}

function go(id: string) {
    document.getElementById(id)?.scrollIntoView({behavior: 'smooth', block: 'start'})
    current.value = id
}

watch(() => props.root, (root, before) => {
    before?.removeEventListener('scroll', follow)
    root?.addEventListener('scroll', follow, {passive: true})
    nextTick(follow)
}, {immediate: true})
watch(() => props.headings, () => nextTick(follow))
onBeforeUnmount(() => props.root?.removeEventListener('scroll', follow))
</script>

<template>
  <nav v-if="headings.length" aria-label="On this page" class="flex flex-col gap-0.5 text-[13px]">
    <p class="label mb-2">On this page</p>
    <a
        v-for="heading in headings"
        :key="heading.id"
        :href="`#${heading.id}`"
        class="block border-l py-1 transition-colors"
        :class="[
            heading.level === 3 ? 'pl-6' : 'pl-3',
            current === heading.id ? 'border-accent-500 text-fg' : 'border-line text-muted hover:border-faint hover:text-fg',
        ]"
        @click.prevent="go(heading.id)"
    >{{ heading.text }}</a>
  </nav>
</template>
