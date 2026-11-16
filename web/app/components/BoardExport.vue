<script setup lang="ts">
// A board downloaded as one file, from App settings (ORR-1248), picking the project here as no project's page is open.
// Its images stay out unless asked for: they're most of a big board's file, and a proxy in front of a hosted orrery
// can refuse a file that big. `?board=<id>` in the address picks one, as a project's Settings links here with it.
const {ordered: projects} = useProjectOrder()
const route = useRoute()
const chosen = ref(typeof route.query.board === 'string' ? route.query.board : '')
const images = ref(false)
watch(projects, now => {
    if (!now.some(p => p.id === chosen.value)) chosen.value = now[0]?.id ?? ''
}, {immediate: true})
const href = computed(() => chosen.value ? apiUrl(`/projects/${encodeURIComponent(chosen.value)}/export${images.value ? '?uploads=1' : ''}`) : undefined)
</script>

<template>
  <div v-if="projects.length" class="flex flex-wrap items-center gap-3">
    <select v-model="chosen" aria-label="Project to export" class="h-8 field text-[13px]">
      <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
    </select>
    <label class="flex items-center gap-2 text-[13px] text-fg">
      <input v-model="images" type="checkbox" class="accent-accent-fill">
      Include its images
    </label>
    <a :href="href" download class="inline-flex items-center rounded-md px-3 py-1.5 text-[13px] font-medium ring-1 ring-line text-fg hover:bg-hover">Download the board</a>
  </div>
  <p v-else class="text-xs text-faint">No projects yet.</p>
</template>
