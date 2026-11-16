<script setup lang="ts">
// Storage, on App settings → Workspace (ORR-1250): the images nothing shows any more (no issue, comment, doc or its
// history, in any workspace) and how much room they take, with one button to remove them. Only those more than a day
// old count, so an image being written into a comment isn't taken. Removing them is the owner's, and on SQLite the
// file is compacted after, when that much came free.
interface Listed {count: number, size: number, uploads: {id: string, size: number, created_by: string, created_at: string, url: string}[]}
const {shared, owner, me} = usePeople()
const isOwner = computed(() => !owner.value || me.value === owner.value)
const {load: ownerName} = useOwner()
const unused = ref<Listed | null>(null)
const failed = ref('')
const busy = ref(false)
const removed = ref<{count: number, size: number, compacted: boolean} | null>(null)

async function load() {
    try {
        unused.value = await apiFetch('/uploads?unused=1')
    } catch (error) {
        failed.value = errorMessage(error)
    }
}
onMounted(load)

async function cleanUp() {
    failed.value = ''
    busy.value = true
    try {
        removed.value = await apiFetch('/uploads?unused=1', {method: 'DELETE', headers: {'Orrery-Actor': await ownerName()}})
        await load()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p v-if="unused && unused.count" class="text-[13px] text-fg">
      {{ unused.count }} {{ unused.count === 1 ? 'image' : 'images' }} nothing shows, taking {{ bytes(unused.size) }}.
    </p>
    <p v-else-if="unused" class="text-[13px] text-muted">Every image here is shown somewhere.</p>
    <div v-if="unused?.count" class="flex items-center gap-3">
      <UiButton size="md" :disabled="busy || !isOwner" @click="cleanUp">Clean up</UiButton>
      <span v-if="!isOwner" class="text-xs text-muted">Only {{ shared ? 'this orrery\'s owner' : 'the owner' }} removes images.</span>
    </div>
    <p v-if="removed" class="text-xs text-muted">
      Removed {{ removed.count }} {{ removed.count === 1 ? 'image' : 'images' }}, {{ bytes(removed.size) }}{{ removed.compacted ? ', and gave the room back to the disk' : '' }}.
    </p>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
