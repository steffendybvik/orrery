<script setup lang="ts">
import type {DocSummary, Project} from '#shared/roadmap'

// A project's docs down the side of the docs pages (a row of tabs on a phone), and New doc after them. Docs with no
// section come first, then each section (ORR-520), A–Z, folding away; the one with the open doc stays open, and what's
// folded is kept per project in this browser. A doc goes to another section by dragging it onto one (onto Docs: none),
// or by right-clicking it. A section is made at the foot (empty until a doc goes in), and renamed or deleted by
// right-clicking its header (ORR-560).
const props = defineProps<{project: Project}>()
const route = useRoute()
const {docUnseen} = useUnseen()

const loose = computed(() => props.project.docs.filter(doc => !doc.section))
const sections = computed(() => {
    const by = new Map<string, DocSummary[]>(props.project.doc_sections.map(name => [name, []]))
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

// Filing a doc, and making, renaming and deleting sections: saved as the owner; the project's patch redraws the list.
const failed = ref('')
async function save(path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: object): Promise<boolean> {
    failed.value = ''
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.project.id)}/${path}`, {method, body})
        return true
    } catch (error) {
        failed.value = errorMessage(error)
        return false
    }
}
async function move(id: string, section: string | null) {
    const doc = props.project.docs.find(d => d.id === id)
    if (!doc || (doc.section ?? null) === section) return
    await save(`docs/${encodeURIComponent(id)}`, 'PATCH', {section})
}
const sectionPath = (name: string) => `doc-sections/${encodeURIComponent(name)}`

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

// Right-click a section's header: Rename… and Delete, which keeps its docs.
const sectionMenu = ref<{x: number, y: number} | null>(null)
const menuSection = ref<string | null>(null)
const renaming = ref(false)
const newName = ref('')
function openSectionMenu(event: MouseEvent, name: string) {
    menuSection.value = name
    renaming.value = false
    newName.value = name
    sectionMenu.value = {x: event.clientX, y: event.clientY}
}
function closeSectionMenu() {
    sectionMenu.value = null
}
async function rename() {
    const from = menuSection.value, name = newName.value.trim()
    closeSectionMenu()
    if (!from || !name || name === from) return
    // A folded section stays folded under its new name.
    if (await save(sectionPath(from), 'PATCH', {name}) && folded.value.includes(from)) {
        fold(from)
        fold(name)
    }
}
async function removeSection() {
    const name = menuSection.value
    closeSectionMenu()
    if (name) await save(sectionPath(name), 'DELETE')
}

// New section, at the foot: one with no docs in it yet.
const making = ref(false)
const madeName = ref('')
async function makeSection() {
    const name = madeName.value.trim()
    if (name && !await save('doc-sections', 'POST', {name})) return
    making.value = false
    madeName.value = ''
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
          @contextmenu.prevent="openSectionMenu($event, section.name)"
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
    <button
        v-if="!making"
        type="button"
        class="hidden shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] text-faint outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:bg-active md:flex"
        @click="making = true"
    >
      <svg class="size-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
      New section
    </button>
    <form v-else class="hidden px-1 py-0.5 md:block" @submit.prevent="makeSection">
      <input
          v-model="madeName"
          class="h-7 w-full rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none"
          placeholder="Section name"
          aria-label="New section"
          maxlength="60"
          autofocus
          @keydown.esc="making = false; madeName = ''"
          @blur="!madeName.trim() && (making = false)"
      >
    </form>
    <p v-if="failed" class="px-2 text-xs text-rose-600 dark:text-rose-400">{{ failed }}</p>
    <DeletedDocs :project="project.id" :docs="project.docs.length" class="hidden md:block md:mt-3" />

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

    <UiContextMenu :at="menuSection ? sectionMenu : null" :label="`Section ${menuSection}`" width="w-56" @close="closeSectionMenu">
      <template v-if="menuSection">
        <div class="truncate px-2 pt-1.5 pb-1 text-xs text-muted">{{ menuSection }}</div>
        <div class="flex flex-col border-t border-line pt-1">
          <UiMenuItem v-if="!renaming" @click="renaming = true">Rename…</UiMenuItem>
          <form v-else class="p-1" @submit.prevent="rename">
            <input v-model="newName" class="h-7 w-full rounded-md bg-well px-2 text-xs text-fg ring-1 ring-line placeholder:text-faint focus:ring-accent-500/50 focus:outline-none" placeholder="Section name" aria-label="Rename section" maxlength="60" autofocus>
          </form>
          <UiMenuItem danger title="Its docs stay, under no section" @click="removeSection">Delete section</UiMenuItem>
        </div>
      </template>
    </UiContextMenu>
  </nav>
</template>
