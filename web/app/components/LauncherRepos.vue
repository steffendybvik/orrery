<script setup lang="ts">
// Connected repos, on Connect under its button (ORR-774): each folder the launchers serve, with its projects and how it
// got there: Connect a repo, a Claude session's channel picking it up (ORR-599), or `--install` by hand. It comes from the
// launchers, so it says what that leaves out. Sessions → Setup points here (LauncherReposLine).
import type {ServedRepo} from '~/composables/useLauncherRepos'

const {repos, loaded} = useLauncherRepos()
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
</script>

<template>
  <section id="connected-repos" ref="section" class="flex scroll-mt-4 flex-col gap-2">
    <h3 class="text-[15px] font-semibold">Connected repos</h3>
    <ul v-if="repos.length" class="overflow-hidden rounded-xl border border-line text-xs dark:bg-panel" aria-label="Connected repos">
      <li v-for="repo in repos" :key="repo.dir" class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line px-3 py-2 last:border-b-0">
        <span class="min-w-0 truncate font-mono text-fg" :title="repo.dir">{{ repo.dir }}</span>
        <span class="text-muted">{{ repo.projects.join(', ') }}</span>
        <span class="ml-auto shrink-0 text-faint" :title="added(repo) ? new Date(added(repo)!).toLocaleString() : undefined">{{ how(repo) }}</span>
      </li>
    </ul>
    <p v-else-if="loaded" class="text-[13px] text-muted">None listed.</p>
    <p class="text-[11px] leading-relaxed text-faint">
      This list comes from the launchers running now, so a repo set up with the pasted line, with no launcher running or pick-up off, isn't on it.
      Picked up: a Claude session opened there added it. Installed: <span class="font-mono">--install</span> in the repo, or connected before this list said so. <span class="font-mono">--uninstall</span>, run in a repo, takes it off.
    </p>
  </section>
</template>
