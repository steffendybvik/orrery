// Remembers the project of each page opened (`useLastProject`), for the pages of no project to open on (ORR-1284).
export default defineNuxtPlugin(() => {
    const route = useRoute()
    const {used} = useLastProject()
    const {projects} = useRoadmaps()
    watch([() => route.params.project, projects], ([on]) => {
        if (typeof on === 'string' && projects.value.some(p => p.id === on)) used(on)
    }, {immediate: true})
})
