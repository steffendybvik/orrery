<script setup lang="ts">
import type {DocSummary, Project} from '#shared/roadmap'

// A project's docs down the side of the docs pages (a row of tabs on a phone), and New doc after them. Docs with no
// section come first, then each section (ORR-520), A–Z, folding away; the one with the open doc stays open, and what's
// folded is kept per project in this browser. A doc goes to another section by dragging it onto one (onto Docs: none),
// or by right-clicking it.
const props = defineProps<{project: Project}>()
const route = useRoute()
const {docUnseen} = useUnseen()
const {load} = useOwner()

const loose = computed(() => props.project.docs.filter(doc => !doc.section))
const sections = computed(() => {
    const by = new Map<string, DocSummary[]>()
    for (const doc of props.project.docs) if (doc.section) by.set(doc.section, [...by.get(doc.section) ?? [], doc])
    return [...by].sort(([a], [b]) => a.localeCompare(b, 'en', {sensitivity: 'base', numeric: true})).map(([name, docs]) => ({name, docs}))
})

// What's folded, per project, in this browser.
const foldKey = computed(() => `orrery-docs-folded:${props.project.id}`)
const folded = ref<string[]>([])
watch(foldKey, key => {
    try {
        folded.value = import.meta.client ? JSON.parse(localStorage.getItem(key) ?? '[]') as string[] : []
    } catch {
        folded.value = []
    }
}, {immediate: true})
const isFolded = (section: {name: string, docs: DocSummary[]}) => folded.value.includes(section.name) && !section.docs.some(d => d.id === route.params.doc)
function fold(name: string) {
    folded.value = folded.value.includes(name) ? folded.value.filter(n => n !== name) : [...folded.value, name]
    localStorage.setItem(foldKey.value, JSON.stringify(folded.value))
}

// Filing a doc: saved as the owner; the project's patch redraws the list.
const failed = ref('')
async function move(id: string, section: string | null) {
    const doc = props.project.docs.find(d => d.id === id)
    if (!doc || (doc.section ?? null) === section) return
    failed.value = ''
    try {
        await $fetch(`/api/projects/${encodeURIComponent(props.project.id)}/docs/${encodeURIComponent(id)}`, {method: 'PATCH', headers: {'Orrery-Actor': await load()}, body: {section}})
    } catch (error) {
        failed.value = errorMessage(error)
    }
}

// Dragging a doc onto a section's header, or onto Docs for none.
const dragging = ref<string | null>(null)
const over = ref<string | null | undefined>(undefined)
function dropOn(section: string | null) {
    if (dragging.value) move(dragging.value, section)
    dragging.value = null
    over.value = undefined
}

// Right-click: Move to section.
const menu = ref<{x: number, y: number} | null>(null)
const menuDoc = ref<DocSummary | null>(null)
const naming = ref(false)
const newSection = ref('')
function openMenu(event: MouseEvent, doc: DocSummary) {
    menuDoc.value = doc
    naming.value = false
    newSection.value = ''
    menu.value = {x: event.clientX, y: event.clientY}
}
function closeMenu() {
    menu.value = null
}
function moveTo(section: string | null) {
    if (menuDoc.value) move(menuDoc.value.id, section)
    closeMenu()
}
</script>

<template>
  <nav class="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 md:w-60 md:flex-col md:gap-0.5 md:overflow-y-auto md:border-r md:border-b-0 md:px-2 md:py-4" aria-label="Docs">
    <p
        class="label mb-1 hidden rounded px-2 md:block"
        :class="over === null && 'bg-active'"
        @dragover.prevent="dragging && (over = null)"
        @dragleave="over = undefined"
        @drop.prevent="dropOn(null)"
    >
      Docs
    </p>
    <DocsNavLink
        v-for="doc in loose"
        :key="doc.id"
        :project="project"
        :doc="doc"
        :here="route.params.doc === doc.id"
        :unseen="docUnseen(project.id, doc)"
        @dragstart="dragging = doc.id; $event.dataTransfer?.setData('text/plain', doc.id)"
        @dragend="dragging = null; over = undefined"
        @contextmenu.prevent="openMenu($event, doc)"
    />
    <section v-for="section in sections" :key="section.name" class="contents md:flex md:flex-col md:gap-0.5" :aria-label="section.name">
      <button
          type="button"
          class="mt-2 hidden items-center gap-1.5 rounded-lg px-2 py-1 text-left text-[11px] font-medium tracking-wide text-faint uppercase transition-colors hover:text-fg md:flex"
          :class="over === section.name && 'bg-active text-fg'"
          :aria-expanded="!isFolded(section)"
          :title="isFolded(section) ? 'Show its docs' : 'Fold its docs'"
          @click="fold(section.name)"
          @dragover.prevent="dragging && (over = section.name)"
          @dragleave="over = undefined"
          @drop.prevent="dropOn(section.name)"
      >
        <svg class="size-3 shrink-0 transition-transform" :class="!isFolded(section) && 'rotate-90'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
        <span class="min-w-0 flex-1 truncate">{{ section.name }}</span>
        <span class="font-mono tabular-nums">{{ section.docs.length }}</span>
      </button>
      <DocsNavLink
          v-for="doc in section.docs"
          :key="doc.id"
          :project="project"
          :doc="doc"
          :here="route.params.doc === doc.id"
          :unseen="docUnseen(project.id, doc)"
          :class="isFolded(section) && 'md:hidden'"
          @dragstart="dragging = doc.id; $event.dataTransfer?.setData('text/plain', doc.id)"
          @dragend="dragging = null; over = undefined"
          @contextmenu.prevent="openMenu($event, doc)"
      />
    </section>
    <button
        type="button"
        class="flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-active md:mt-1 md:shrink"
        @click="useNewDoc().open(project.id)"
    >
      <svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      New doc
    </button>
    <p v-if="failed" class="px-2 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>

    <UiContextMenu :at="menuDoc ? menu : null" :label="`Move ${menuDoc?.title}`" width="w-56" @close="closeMenu">
      <template v-if="menuDoc">
        <div class="truncate px-2 pt-1.5 pb-1 text-xs text-muted">Move to section</div>
        <div class="flex flex-col border-t border-line pt-1">
          <UiMenuItem v-for="section in sections" :key="section.name" :active="menuDoc.section === section.name" @click="moveTo(section.name)">{{ section.name }}</UiMenuItem>
          <UiMenuItem muted :active="!menuDoc.section" @click="moveTo(null)">No section</UiMenuItem>
          <UiMenuItem v-if="!naming" muted @click="naming = true">+ New section…</UiMenuItem>
          <form v-else class="p-1" @submit.prevent="newSection.trim() && moveTo(newSection.trim())">
            <input v-model="newSection" class="h-7 w-full rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none" placeholder="Section name" aria-label="New section" maxlength="60" autofocus>
          </form>
        </div>
      </template>
    </UiContextMenu>
  </nav>
</template>
