// Counts each page opened (ORR-881), by its route's name, while the owner has counting on: one hook for every page.
export default defineNuxtPlugin(() => {
    const {count} = useUsage()
    useRouter().afterEach((to, from) => {
        if (to.name && to.name !== from.name) count(`page:${String(to.name)}`)
    })
})
