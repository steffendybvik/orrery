<script setup lang="ts">
// An artifact drawn on its doc's page (ORR-677). The frame is the error boundary and the lock: with `allow-scripts` alone it
// has no origin, so what's inside can throw, but can't reach the app. Nothing else on the page ever renders its HTML. It
// follows the app's dark mode and the doc's changes by being served again. What this can't catch is an endless loop, as a
// sandboxed frame usually shares the tab's thread: that slows the tab until it's left.
const props = defineProps<{project: string, doc: string, version: string}>()
const {dark} = useTheme()

const reloads = ref(0)
const failed = ref('')
const address = computed(() => apiUrl(`/projects/${encodeURIComponent(props.project)}/docs/${encodeURIComponent(props.doc)}/artifact?theme=${dark.value ? 'dark' : 'light'}&v=${encodeURIComponent(props.version)}`))
// A frame says it loaded whatever came back, an error page too, so the address is tried first.
const src = ref<string | null>(null)
watch([address, reloads], async ([url], _, onCleanup) => {
    let left = false
    onCleanup(() => left = true)
    failed.value = ''
    try {
        const answer = await fetch(url)
        if (left) return
        if (answer.ok) src.value = url
        else failed.value = `It didn't load: the server said ${answer.status}.`
    } catch {
        if (!left) failed.value = "It didn't load: the server can't be reached."
    }
}, {immediate: true})
</script>

<template>
  <section class="flex flex-col gap-2" aria-label="Artifact">
    <div class="flex items-center justify-end gap-2 text-xs text-faint">
      <span v-if="failed" role="alert" class="mr-auto text-rose-600 dark:text-rose-400">{{ failed }}</span>
      <UiButton variant="ghost" size="xs" title="Draw it again" @click="reloads++">Reload</UiButton>
    </div>
    <iframe
        v-if="src && !failed"
        :key="`${src}:${reloads}`"
        :src="src"
        sandbox="allow-scripts"
        title="Artifact"
        class="h-[80vh] w-full rounded-xl ring-1 ring-line"
    />
  </section>
</template>
