<script setup lang="ts">
// Who's on this orrery, on App settings (ORR-657): the owner adds and removes them. Removing someone sends their open issues
// back to unassigned and stops their keys at once. A second person turns login on, which the server says how to be ready for.
const {here, me, owner, load} = usePeople()
const name = ref('')
const busy = ref(false)
const failed = ref('')
const isOwner = computed(() => !owner.value || me.value === owner.value)
async function run(work: () => Promise<unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await work()
        await load()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
const add = () => run(async () => {
    await apiFetch('/people', {method: 'POST', body: {name: name.value.trim()}})
    name.value = ''
})
const remove = (id: string) => run(() => apiFetch(`/people/${encodeURIComponent(id)}`, {method: 'DELETE'}))
</script>

<template>
  <div class="flex flex-col gap-2">
    <ul class="flex flex-col gap-1 text-[13px] text-fg">
      <li v-for="person in here" :key="person.id" class="flex items-center gap-2">
        <span>{{ person.name }}</span>
        <span v-if="person.role === 'owner'" class="text-xs text-muted">owner</span>
        <UiButton v-else-if="isOwner" variant="danger-ghost" size="xs" class="ml-auto" :disabled="busy" :aria-label="`Remove ${person.name}`" @click="remove(person.id)">Remove</UiButton>
      </li>
    </ul>
    <form v-if="isOwner" class="flex flex-wrap items-center gap-2" @submit.prevent="add">
      <input v-model="name" aria-label="Their name" placeholder="Their name" maxlength="60" class="h-8 w-72 max-w-full field">
      <UiButton type="submit" variant="primary" size="md" :disabled="busy || !name.trim()">Add a person</UiButton>
    </form>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
