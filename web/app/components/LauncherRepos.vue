<script setup lang="ts">
// Connected repos, on Connect under its button (ORR-774): each folder the launchers serve, with its projects and how it
// got there: Connect a repo, a Claude session's channel picking it up (ORR-599), or `--install` by hand. It comes from the
// launchers, so it says what that leaves out. Sessions → Setup points here (LauncherReposLine). Remove (ORR-1260) asks
// the launchers serving it to take it off their list, after asking; the projects, issues and sessions stay.
import type {ServedRepo} from '~/composables/useLauncherRepos'

const {repos, loaded, ask} = useLauncherRepos()
const route = useRoute()
const section = useTemplateRef<HTMLElement>('section')
// The page scrolls inside its own box, which the router's scrolling to a hash doesn't reach.
watch(loaded, async () => {
    if (route.hash !== '#connected-repos') return
    await nextTick()
    section.value?.scrollIntoView({block: 'start'})
})

const added = (repo: ServedRepo) => repo.connected_at ?? repo.picked_at
const how = (repo: ServedRepo) => repo.connected_at
    ? `connected ${ago(repo.connected_at)}`
    : repo.picked_at ? `picked up ${ago(repo.picked_at)}` : 'installed'

const asking = ref<string | null>(null)
const removing = ref<string | null>(null)
const refused = ref<Record<string, string>>({})

/** Asks its launchers to take it off, then asks again until it's gone from the list: a launcher follows its list
 * within a few seconds. One that's still there runs older code, which doesn't know Remove. */
async function remove(repo: ServedRepo) {
    removing.value = repo.dir
    const {[repo.dir]: _, ...rest} = refused.value
    refused.value = rest
    try {
        await apiFetch('/connects/remove', {method: 'POST', body: {dir: repo.dir, projects: repo.ids}})
        for (let tries = 0; tries < 10; tries++) {
            await new Promise(resolve => setTimeout(resolve, 1500))
            await ask()
            if (!repos.value.some(r => r.dir === repo.dir)) break
        }
        if (repos.value.some(r => r.dir === repo.dir)) {
            refused.value = {...refused.value, [repo.dir]: 'Its launcher didn\'t take it off: it may run older code. Update it (git pull where it runs from), or run --uninstall in the repo.'}
        }
        asking.value = null
    } catch (error) {
        refused.value = {...refused.value, [repo.dir]: errorMessage(error, 'remove')}
    } finally {
        removing.value = null
    }
}
</script>

<template>
  <section id="connected-repos" ref="section" class="flex scroll-mt-4 flex-col gap-2">
    <h3 class="text-[15px] font-semibold">Connected repos</h3>
    <ul v-if="repos.length" class="overflow-hidden rounded-xl border border-line text-xs dark:bg-panel" aria-label="Connected repos">
      <li v-for="repo in repos" :key="repo.dir" class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2 last:border-b-0">
        <span class="min-w-0 truncate font-mono text-fg" :title="repo.dir">{{ repo.dir }}</span>
        <span class="text-muted">{{ repo.projects.join(', ') }}</span>
        <span class="ml-auto shrink-0 text-faint" :title="added(repo) ? new Date(added(repo)!).toLocaleString() : undefined">{{ how(repo) }}</span>
        <UiButton v-if="asking !== repo.dir" size="xs" :disabled="!!removing" :aria-label="`Remove ${repo.dir}`" @click="asking = repo.dir">Remove…</UiButton>
        <UiConfirm v-if="asking === repo.dir" class="w-full" :busy="removing === repo.dir" @confirm="remove(repo)" @cancel="asking = null">
          Remove {{ repo.dir }}? Its launcher stops serving {{ repo.projects.join(', ') }} there, and pick-up leaves it off. The {{ repo.projects.length === 1 ? 'project' : 'projects' }}, issues and running sessions stay, and Connect a repo puts it back.
        </UiConfirm>
        <p v-if="refused[repo.dir]" class="w-full text-xs text-rose-700 dark:text-rose-400">{{ refused[repo.dir] }}</p>
      </li>
    </ul>
    <p v-else-if="loaded" class="text-[13px] text-muted">None listed.</p>
    <p class="text-[11px] leading-relaxed text-faint">
      This list comes from the launchers running now, so a repo set up with the pasted line, with no launcher running or pick-up off, isn't on it.
      Picked up: a Claude session opened there added it. Installed: <span class="font-mono">--install</span> in the repo, or connected before this list said so. <strong class="font-medium">Remove</strong>, or <span class="font-mono">--uninstall</span> run in a repo, takes it off.
    </p>
  </section>
</template>
