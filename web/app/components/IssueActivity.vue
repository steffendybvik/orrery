<script setup lang="ts">
import type {Comment, Issue, IssueEvent, Project} from '#shared/roadmap'

// An issue's activity on its page: who made it, its comments, and between them what changed, with the box
// for a new comment. The owner's own comments edit and come out in place.
const props = defineProps<{project: Project, issue: Issue}>()
const emit = defineEmits<{comments: [Comment[]]}>()
const {who} = useOwner()

const comments = ref<Comment[]>([])
// Once they're read, and as they change, so the page can copy the whole issue.
watch(comments, list => emit('comments', list))
const activity = ref<IssueEvent[]>([])
watch(() => [props.project.id, props.issue.id, props.issue.updated_at] as const, async ([p, i], _, onCleanup) => {
    // Gone on to another issue (j/k) before these came back: they're that one's no longer.
    let stale = false
    onCleanup(() => stale = true)
    const base = `/projects/${encodeURIComponent(p)}/issues/${encodeURIComponent(i)}`
    const loaded = await Promise.all([
        apiFetch<Comment[]>(`${base}/comments`).catch(() => []),
        apiFetch<IssueEvent[]>(`${base}/activity`).catch(() => []),
    ])
    if (!stale) [comments.value, activity.value] = loaded
}, {immediate: true})

const {look} = useStatuses()
const PROPOSAL_SAID: Record<string, string> = {pending: 'put it up as a proposal', approved: 'approved the proposal', changes: 'asked for changes to the proposal', rejected: 'rejected the proposal'}

const list = (value?: string) => (JSON.parse(value ?? '[]') ?? []) as string[]

/** One change as words: "moved it to In progress", "assigned Claude". */
function said(event: IssueEvent): string[] {
    const {field, before, after} = event
    if (field === 'status') return [`moved it to ${look(after ?? '').label}`]
    if (field === 'priority') return [after ? `set the priority to ${PRIORITY_LABEL[after] ?? after}` : 'took the priority off']
    if (field === 'assignee') return [after ? `assigned ${who(after)}` : 'unassigned it']
    if (field === 'claim') return [after ? before ? `took it over from ${who(before)}` : 'took it up' : 'let it go']
    if (field === 'title') return [`renamed it from “${before ?? ''}”`]
    if (field === 'notes') return ['edited the description']
    if (field === 'parent') return [after ? `made it a sub-issue of ${after}` : 'made it a top-level issue']
    if (field === 'project') return [`moved it here from ${before}`]
    if (field === 'proposal') return [after ? PROPOSAL_SAID[after] ?? after : before === 'approved' ? 'put it on the roadmap' : 'committed it']
    if (field === 'chunk') {
        const title = props.project.board.chunks.find(c => c.id === after)?.title ?? after
        return [after ? `put it in ${title}` : 'took it out of its chunk']
    }
    if (field === 'labels') {
        const [was, now] = [list(before), list(after)]
        return [
            ...now.filter(l => !was.includes(l)).map(l => `added the label ${l}`),
            ...was.filter(l => !now.includes(l)).map(l => `took off the label ${l}`),
        ]
    }
    if (field === 'external') {
        const [was, now] = [list(before), list(after)]
        return [
            ...now.filter(t => !was.includes(t)).map(t => `linked the team task ${t}`),
            ...was.filter(t => !now.includes(t)).map(t => `unlinked the team task ${t}`),
        ]
    }
    if (field === 'github_issues') {
        const [was, now] = [list(before), list(after)]
        return [
            ...now.filter(g => !was.includes(g)).map(g => `linked the GitHub issue ${g}`),
            ...was.filter(g => !now.includes(g)).map(g => `unlinked the GitHub issue ${g}`),
        ]
    }
    if (field === 'depends') {
        const [was, now] = [list(before), list(after)]
        return [
            ...now.filter(d => !was.includes(d)).map(d => `made it depend on ${d}`),
            ...was.filter(d => !now.includes(d)).map(d => `took off its dependency on ${d}`),
        ]
    }
    return []
}

/** Comments, and between them the changes, each write's changes as one line ("claude moved it to
 * In progress and assigned Claude"). Made is the line at the top, so `created` isn't repeated. */
const timeline = computed(() => {
    type Entry = {key: string, at: string, comment?: Comment, by?: string, session?: string, words?: string[]}
    const lines: (Entry & {words: string[]})[] = []
    for (const event of activity.value) {
        const words = event.field === 'created' ? [] : said(event)
        if (!words.length) continue
        const last = lines.at(-1)
        if (last && last.at === event.created_at && last.by === event.created_by && last.session === event.session_name) last.words.push(...words)
        else lines.push({key: `e${event.id}`, at: event.created_at, by: event.created_by, session: event.session_name, words})
    }
    const all: (Entry & {text?: string})[] = [
        ...lines.map(l => ({...l, text: l.words.length > 1 ? `${l.words.slice(0, -1).join(', ')} and ${l.words.at(-1)}` : l.words[0]})),
        ...comments.value.map(c => ({key: `c${c.id}`, at: c.created_at, comment: c})),
    ]
    return all.sort((a, b) => a.at.localeCompare(b.at))
})

// While the issue waits on the owner (`issue.waiting`), the question it waits on, quoted at the top with its Markdown
// rendered and cut to three lines: a click on it (not on a link in it) shows it in the thread, Answer goes to the
// comment box.
const question = computed(() => props.issue.waiting ? comments.value.findLast(c => c.asks && c.answered === false) : undefined)
const answerBox = ref<HTMLElement | null>(null)
function showQuestion() {
    if (question.value) document.getElementById(`comment-${question.value.id}`)?.scrollIntoView({behavior: 'smooth', block: 'center'})
}
function answer() {
    answerBox.value?.scrollIntoView({behavior: 'smooth', block: 'center'})
    answerBox.value?.querySelector('textarea')?.focus({preventScroll: true})
}
// The owner's own comments edit in place, and come out after asking once more in place.
const editingComment = ref<number | null>(null)
const removingComment = ref<{id: number, busy?: boolean, failed?: string} | null>(null)
watch(() => props.issue.id, () => {
    editingComment.value = null
    removingComment.value = null
})
function edited(comment: Comment) {
    comments.value = comments.value.map(c => c.id === comment.id ? comment : c)
    editingComment.value = null
}
// A working session's request for a schedule, answered here (ORR-458): the answer is the owner's comment too, which
// comes in with the issue's next change.
const answeringSchedule = ref<number | null>(null)
const scheduleFailed = ref<{id: number, message: string} | null>(null)
async function answerSchedule(id: number, allow: boolean) {
    answeringSchedule.value = id
    scheduleFailed.value = null
    try {
        const comment = await apiFetch<Comment>(`/projects/${encodeURIComponent(props.project.id)}/issues/${encodeURIComponent(props.issue.id)}/schedule-requests/${id}`,
            {method: 'POST', body: {allow}})
        comments.value = comments.value.map(c => c.id === comment.id ? comment : c)
    } catch (error) {
        scheduleFailed.value = {id, message: errorMessage(error, allow ? 'allow it' : 'deny it')}
    } finally {
        answeringSchedule.value = null
    }
}
async function removeComment(id: number) {
    removingComment.value = {id, busy: true}
    try {
        await apiFetch(`/projects/${encodeURIComponent(props.project.id)}/issues/${encodeURIComponent(props.issue.id)}/comments/${id}`, {method: 'DELETE'})
        comments.value = comments.value.filter(c => c.id !== id)
        removingComment.value = null
    } catch (error) {
        removingComment.value = {id, failed: errorMessage(error, 'delete')}
    }
}
</script>

<template>
  <section class="flex flex-col gap-3">
    <h2 class="label">Activity</h2>
    <div v-if="question" id="waiting" class="flex scroll-mt-20 flex-col gap-2 rounded-xl bg-violet-500/8 p-3 ring-1 ring-violet-500/35">
      <div class="flex items-center gap-2 text-xs">
        <WaitingChip :asks="question.asks!" />
        <span class="text-muted">{{ who(question.created_by, question.session_name) }} asked {{ ago(question.created_at) }}</span>
        <UiButton variant="primary" size="xs" class="ml-auto" @click="answer">Answer</UiButton>
      </div>
      <div
          role="button"
          tabindex="0"
          class="line-clamp-3 rounded-md text-left text-fg hover:[&_p]:underline focus-visible:ring-2 focus-visible:ring-accent-500/60 focus-visible:outline-none"
          title="Show it in the thread"
          @click="!($event.target as HTMLElement).closest('a') && showQuestion()"
          @keydown.enter.self="showQuestion"
      >
        <MarkdownView :source="question.body" class="text-[13px] leading-5" />
      </div>
    </div>
    <ol class="relative flex flex-col gap-5 border-l border-line pl-5">
      <li class="text-xs text-faint">
        <span class="absolute -left-[3px] mt-1.5 size-1.5 rounded-full bg-faint/60" />
        <span class="text-muted">{{ who(issue.created_by, issue.session_name) }}</span> created the issue · <span :title="issue.created_at">{{ ago(issue.created_at) }}</span>
      </li>
      <template v-for="entry in timeline" :key="entry.key">
        <li v-if="!entry.comment" class="text-xs text-faint">
          <span class="absolute -left-[3px] mt-1.5 size-1.5 rounded-full bg-faint/60" />
          <span class="text-muted">{{ who(entry.by!, entry.session) }}</span> {{ entry.text }} · <span :title="entry.at">{{ ago(entry.at) }}</span>
        </li>
        <li v-else :id="`comment-${entry.comment.id}`" class="group flex scroll-mt-20 flex-col gap-1.5">
          <div class="-ml-[31px] flex items-center gap-2 text-xs">
            <PersonAvatar :name="entry.comment.created_by" :size="20" />
            <span class="font-medium text-fg">{{ who(entry.comment.created_by, entry.comment.session_name) }}</span>
            <span class="text-faint" :title="entry.comment.created_at">{{ ago(entry.comment.created_at) }}{{ entry.comment.updated_at !== entry.comment.created_at ? ' · edited' : '' }}</span>
            <span
                v-if="entry.comment.asks"
                class="rounded-full px-1.5 py-px text-[10px] font-medium ring-1"
                :class="entry.comment.answered ? 'text-faint ring-line' : 'bg-violet-500/12 text-violet-700 ring-violet-500/35 dark:text-violet-300'"
            >{{ entry.comment.answered ? `${entry.comment.asks === 'decision' ? 'Decision' : 'Feedback'} answered` : entry.comment.asks === 'decision' ? 'Decision needed' : 'Feedback needed' }}</span>
            <UiConfirm
                v-if="removingComment?.id === entry.comment.id"
                inline
                size="xs"
                class="ml-auto"
                action="Delete"
                busy-action="Deleting…"
                :busy="removingComment.busy"
                @confirm="removeComment(entry.comment.id)"
                @cancel="removingComment = null"
            >
              Delete the comment?
            </UiConfirm>
            <span v-else class="ml-auto flex items-center gap-0.5 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:focus-within:opacity-100">
              <template v-if="entry.comment.protected && editingComment !== entry.comment.id">
                <UiButton variant="ghost" size="xs" @click="editingComment = entry.comment.id">Edit</UiButton>
                <UiButton variant="danger-ghost" size="xs" @click="removingComment = {id: entry.comment.id}">Delete</UiButton>
              </template>
              <CopyButton :text="entry.comment.body" name="the comment" />
            </span>
          </div>
          <p v-if="removingComment?.id === entry.comment.id && removingComment.failed" class="text-xs text-rose-600 dark:text-rose-400">{{ removingComment.failed }}</p>
          <CommentBox
              v-if="editingComment === entry.comment.id"
              :project="project.id"
              :issue="issue.id"
              :comment="entry.comment"
              @posted="edited"
              @cancel="editingComment = null"
          />
          <div v-else class="rounded-xl bg-well px-4 py-3 ring-1 ring-line"><MarkdownView :source="entry.comment.body" class="text-[14px] leading-6" /></div>
          <ScheduleRequestCard
              v-if="entry.comment.schedule"
              :request="entry.comment.schedule"
              :busy="answeringSchedule === entry.comment.id"
              expired="Expired: asked again since"
              @answer="allow => answerSchedule(entry.comment!.id, allow)"
          />
          <p v-if="scheduleFailed?.id === entry.comment.id" class="text-xs text-rose-600 dark:text-rose-400">{{ scheduleFailed.message }}</p>
        </li>
      </template>
    </ol>
    <div ref="answerBox">
      <CommentBox :project="project.id" :issue="issue.id" @posted="c => comments = [...comments.filter(x => x.id !== c.id), c]" />
    </div>
  </section>
</template>
