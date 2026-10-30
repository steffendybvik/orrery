<script setup lang="ts">
import type {BoardMember} from '#shared/roadmap'

// Who holds a board and who's on it, on its Settings (ORR-657), with more than one person. Its holder or the owner says who
// is, and the server holds them to that.
const props = defineProps<{project: string}>()
const {here, me, owner} = usePeople()
const members = ref<BoardMember[]>([])
const picked = ref('')
const busy = ref(false)
const failed = ref('')
const base = computed(() => `/projects/${encodeURIComponent(props.project)}/members`)
const manages = computed(() => me.value === owner.value || members.value.some(m => m.role === 'owner' && m.person === me.value))
const others = computed(() => here.value.filter(person => !members.value.some(m => m.person === person.id)))
async function read() {
    members.value = await apiFetch<BoardMember[]>(base.value).catch(() => [])
}
async function run(work: () => Promise<unknown>) {
    busy.value = true
    failed.value = ''
    try {
        await work()
        await read()
    } catch (error) {
        failed.value = errorMessage(error)
    } finally {
        busy.value = false
    }
}
const add = () => run(async () => {
    await apiFetch(base.value, {method: 'POST', body: {person: picked.value}})
    picked.value = ''
})
const remove = (person: string) => run(() => apiFetch(`${base.value}/${encodeURIComponent(person)}`, {method: 'DELETE'}))
watch(() => props.project, read, {immediate: true})
</script>

<template>
  <section id="members" class="flex flex-col gap-3 border-t border-line pt-8">
    <div>
      <h2 class="text-[15px] font-semibold text-fg">Members</h2>
      <p class="mt-0.5 text-[13px] text-muted">Who can work on this board. The owner can always reach it, and anyone else gets a 404.</p>
    </div>
    <ul class="flex flex-col gap-1 text-[13px] text-fg">
      <li v-for="member in members" :key="member.person" class="flex items-center gap-2">
        <span>{{ member.name }}</span>
        <span v-if="member.role === 'owner'" class="text-xs text-muted">holds it</span>
        <UiButton v-else-if="manages" variant="danger-ghost" size="xs" class="ml-auto" :disabled="busy" :aria-label="`Remove ${member.name}`" @click="remove(member.person)">Remove</UiButton>
      </li>
    </ul>
    <form v-if="manages && others.length" class="flex flex-wrap items-center gap-2" @submit.prevent="add">
      <select v-model="picked" aria-label="Who to add" class="h-8 w-72 max-w-full field">
        <option value="" disabled>Who to add</option>
        <option v-for="person in others" :key="person.id" :value="person.id">{{ person.name }}</option>
      </select>
      <UiButton type="submit" size="md" :disabled="busy || !picked">Add to this board</UiButton>
    </form>
    <p v-if="failed" class="text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
  </section>
</template>
