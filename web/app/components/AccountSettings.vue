<script setup lang="ts">
// Your account on App settings (ORR-1203), shown only while you're signed in: who you're signed in as, how, since when
// and the workspaces you're in, with Sign out; and deleting it, which takes every workspace you own with it, shared or
// not, so the button waits until you type your name. orrery keeps no email, so none shows. A workspace you own can be
// deleted on its own from its row, with everything in it, once you type its name; the first one, `default`, can't.
export interface Account {
    id: string
    name: string
    role: 'owner' | 'member'
    created_at: string | null
    identities: {issuer: string}[]
    workspaces: {id: string, name: string, color: string | null, role: 'owner' | 'member'}[]
}

const {logOut} = useAuth()
const {load: loadWorkspaces, here} = useWorkspaces()
/** The workspace whose delete is open, and its name as typed. */
const deleting = ref('')
const typedSpace = ref('')
const account = ref<Account | null>(null)
const failed = ref('')
const typed = ref('')
const busy = ref(false)

onMounted(async () => {
    try {
        account.value = await apiFetch<Account>('/me', {headers: {}})
    } catch (error) {
        failed.value = errorMessage(error, 'read')
    }
})

const owned = computed(() => account.value?.workspaces.filter(w => w.role === 'owner') ?? [])
const matches = computed(() => !!account.value && typed.value.trim().toLowerCase() === account.value.name.trim().toLowerCase())
/** A login provider by its address, as `accounts.example.com`: the issuer is a URL, or a name when it isn't one. */
function provider(issuer: string) {
    try {
        return new URL(issuer).host || issuer
    } catch {
        return issuer
    }
}
const when = (stamp: string) => new Date(stamp).toLocaleDateString()
const spaceMatches = (name: string) => typedSpace.value.trim().toLowerCase() === name.trim().toLowerCase()

function startDelete(id: string) {
    deleting.value = deleting.value === id ? '' : id
    typedSpace.value = ''
    failed.value = ''
}

async function removeWorkspace(workspace: Account['workspaces'][number]) {
    if (!spaceMatches(workspace.name) || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await apiFetch(`/workspaces/${encodeURIComponent(workspace.id)}`, {method: 'DELETE', headers: {}, body: {confirm: typedSpace.value}})
        // The one you're in gone, the page starts again in one you still have.
        if (here.value === workspace.id) return location.assign('/')
        if (account.value) account.value.workspaces = account.value.workspaces.filter(w => w.id !== workspace.id)
        deleting.value = ''
        await loadWorkspaces(true)
    } catch (error) {
        failed.value = errorMessage(error, 'delete')
    } finally {
        busy.value = false
    }
}

async function remove() {
    if (!matches.value || busy.value) return
    busy.value = true
    failed.value = ''
    try {
        await apiFetch('/me', {method: 'DELETE', headers: {}, body: {confirm: typed.value}})
        location.assign('/login')
    } catch (error) {
        failed.value = errorMessage(error, 'delete')
        busy.value = false
    }
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <template v-if="account">
      <dl class="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-xs" aria-label="Your account">
        <dt class="text-muted">Name</dt>
        <dd class="text-fg">{{ account.name }}</dd>
        <dt class="text-muted">Id</dt>
        <dd class="font-mono text-fg">{{ account.id }}</dd>
        <dt class="text-muted">Signed in with</dt>
        <dd class="text-fg">{{ account.identities.length ? account.identities.map(i => provider(i.issuer)).join(', ') : 'a person key' }}</dd>
        <dt class="text-muted">Joined</dt>
        <dd class="text-fg">{{ account.created_at ? when(account.created_at) : 'before orrery kept the date' }}</dd>
        <dt class="text-muted">Workspaces</dt>
        <dd class="text-fg">
          <ul v-if="account.workspaces.length" class="flex flex-col gap-0.5" aria-label="Your workspaces">
            <li v-for="workspace in account.workspaces" :key="workspace.id" class="flex flex-col gap-1.5">
              <span class="flex items-center gap-2">
                <span>{{ workspace.name }} <span class="text-muted">{{ workspace.role }}</span></span>
                <button
                    v-if="workspace.role === 'owner' && workspace.id !== 'default'"
                    type="button"
                    class="text-[11px] text-rose-700 hover:underline dark:text-rose-400"
                    :aria-expanded="deleting === workspace.id"
                    @click="startDelete(workspace.id)"
                >{{ deleting === workspace.id ? 'Keep it' : 'Delete' }}</button>
              </span>
              <form
                  v-if="deleting === workspace.id"
                  class="flex flex-col gap-2 rounded-md p-2 ring-1 ring-rose-500/40"
                  :aria-label="`Delete ${workspace.name}`"
                  @submit.prevent="removeWorkspace(workspace)"
              >
                <span class="text-muted">Its projects, issues, docs, schedules and secrets go with it, for everyone in it. It can't be undone.</span>
                <span class="flex flex-wrap items-center gap-2">
                  <input
                      v-model="typedSpace"
                      :aria-label="`Type its name, ${workspace.name}, to confirm`"
                      :placeholder="workspace.name"
                      autocomplete="off"
                      spellcheck="false"
                      class="h-8 w-56 max-w-full field"
                  >
                  <UiButton type="submit" variant="danger" size="md" :disabled="!spaceMatches(workspace.name) || busy">Delete workspace</UiButton>
                </span>
              </form>
            </li>
          </ul>
          <span v-else class="text-muted">none</span>
        </dd>
      </dl>
      <div>
        <UiButton size="md" @click="logOut">Sign out</UiButton>
      </div>

      <div class="flex flex-col gap-3 rounded-lg p-3 ring-1 ring-rose-500/40" aria-label="Delete my account" role="group">
        <h3 class="text-[13px] font-semibold text-rose-700 dark:text-rose-400">Delete my account</h3>
        <p class="text-xs text-muted">
          This deletes your account and every workspace you own, with everything in them: projects, issues, docs, epics,
          schedules and secrets. That includes workspaces other people are in: they lose them too.
          In workspaces you don't own, your issues go back to unassigned, and what you did there shows as by a
          “Deleted person”: your name comes off it.
          <template v-if="account.role === 'owner'">You own this orrery: it goes to whoever has been on it longest.</template>
          It can't be undone.
        </p>
        <p v-if="owned.length" class="text-xs text-fg">Goes with it: {{ owned.map(w => w.name).join(', ') }}</p>
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="remove">
          <input
              v-model="typed"
              :aria-label="`Type your name, ${account.name}, to confirm`"
              :placeholder="account.name"
              autocomplete="off"
              spellcheck="false"
              maxlength="60"
              class="h-8 w-72 max-w-full field"
          >
          <UiButton type="submit" variant="danger" size="md" :disabled="!matches || busy">Delete my account</UiButton>
        </form>
      </div>
    </template>
    <p v-if="failed" class="text-xs text-rose-700 dark:text-rose-400">{{ failed }}</p>
  </div>
</template>
