<script setup lang="ts">
import type {DeletedDoc} from '#shared/roadmap'

// A project's removed docs, folded at the foot of its docs: each opens on its page, to read and bring back (ORR-675).
// Asked again as the number of `docs` changes, which removing or bringing one back does.
const props = defineProps<{project: string, docs: number}>()
const {who} = useOwner()

const removed = ref<DeletedDoc[]>([])
watch(() => [props.project, props.docs] as const, async ([project], _, onCleanup) => {
    let left = false
    onCleanup(() => left = true)
    const list = await $fetch<DeletedDoc[]>(`/api/projects/${encodeURIComponent(project)}/deleted-docs`).catch(() => null)
    if (!left && list) removed.value = list
}, {immediate: true})
</script>

<template>
  <details v-if="removed.length" class="group">
    <summary class="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium tracking-wide text-faint uppercase transition-colors hover:text-fg">
      <svg class="size-3 shrink-0 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
      <span class="min-w-0 flex-1 truncate">Removed</span>
      <span class="font-mono tabular-nums">{{ removed.length }}</span>
    </summary>
    <NuxtLink
        v-for="doc in removed"
        :key="doc.id"
        :to="`/p/${project}/docs/${doc.id}`"
        class="block truncate rounded-lg px-2 py-1.5 text-[13px] text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-active"
        :title="`Removed by ${who(doc.deleted_by)} ${ago(doc.deleted_at)}`"
    >{{ doc.title }}</NuxtLink>
  </details>
</template>
