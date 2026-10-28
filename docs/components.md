# UI components

The page is built from a small set of pieces. Reach for one of these before writing a button, a dialog or a
menu by hand, and add to the set rather than copy markup from another page. Components in
`web/app/components/` are auto-imported by their file name; those in `components/ui/` get a `Ui` prefix.

Under `pnpm dev`, `/ui` shows the kit on one page, each piece in its states.

## The kit (`components/ui/`)

### UiButton

Every button and button-shaped link.

```vue
<UiButton variant="primary" size="md" type="submit" :disabled="!ready">Create issue</UiButton>
<UiButton @click="cancel">Cancel</UiButton>
<UiButton variant="ghost" size="xs" square aria-label="Close" @click="close"><XMarkIcon class="size-4" /></UiButton>
<UiButton to="/settings" variant="ghost">App settings</UiButton>
```

| Prop | Values | |
|---|---|---|
| `variant` | `secondary` (default), `primary`, `ghost`, `danger`, `danger-outline`, `danger-ghost`, `success`, `success-outline`, `warning-outline` | see below |
| `size` | `sm` (default, h-7), `xs` (h-6), `md` (h-8) | `md` in dialogs and forms, `xs` in rows and beside text |
| `square` | | an icon's size, for a button with only an icon (give it an `aria-label`) |
| `type` | `button` (default), `submit` | |
| `to` | a path | renders a `NuxtLink` that looks the same |

- **primary:** the one thing to do here (Create, Save, Start session). One per place.
- **secondary:** everything else that's a button: Cancel, Edit, Show older.
- **ghost:** no outline, for toolbars, rows and icons.
- **danger:** removes something, once it's been asked (inside `UiConfirm`, a delete dialog).
- **danger-outline:** asks to remove (Delete project…).
- **danger-ghost:** a quiet remove, red only on hover (the trash icon on a release, Delete on a comment).
- **success:** approves (a proposal).
- **success-outline**, **warning-outline:** a step that moves something on, coloured like the state it leads
  to (Mark shipped in green, Freeze features in amber, as their badges are).

Classes given where it's used should only *place* it: `ml-auto`, `flex-1`, `w-full`, `shrink-0`, `self-end`. A
class that changes how it looks (padding, colour, height) fights the component's own, and which one wins
depends on the stylesheet's order, not the attribute's. To hide it on a phone use `max-md:hidden`, since
`hidden md:block` clashes with its `inline-flex`. If no variant fits, add one here rather than restyle it.

### UiDialog

A dialog over the dimmed page: a form on the glass panel, near the top, scrolling with the page when it's
taller than the window. It's Headless UI's `Dialog`: the focus stays inside while it's open and goes back after, and
the page under it doesn't scroll. It draws in a portal on the page's body, so a component test finds it there
(`new DOMWrapper(document.body)`), not inside the component. A test that saves from a dialog waits until it has
closed (its open state, `useNewIssue().target` say, back to `null`), not only until the request is sent: a save still
on its way closes the next test's dialog when it lands (ORR-409).

```vue
<UiDialog :open="target" label="New chunk" @close="close" @submit="create">
  <input v-model="title" ...>
  <div class="flex items-center gap-2 border-t border-line pt-3">
    <UiButton type="submit" variant="primary" size="md" class="ml-auto">Create chunk</UiButton>
  </div>
</UiDialog>
```

- `open` shows it (anything truthy). `label` is its accessible name.
- Esc and a press on the dimmed page emit `close`; with `required` they don't (naming the owner).
- Enter in a field (a submit button) and ⌘↵ emit `submit`.
- `width`: `md`, `lg` (default), `xl`, `2xl`. `flush` drops the padding and gap, for one that lays out its own
  rows (⌘K). Classes go on the panel (`max-h-[76vh]`).
- Everything inside is a slot, so the dialog keeps its own header (a `KeyHint` for esc) and footer.

### `menu` and UiMenuItem

A menu or popover is a `menu` (a CSS utility: the glass panel, rounded, padded, a column), with where it sits and
how wide beside it. Its lines are `UiMenuItem`s. A menu that opens from a button is Headless UI's `Menu`, each line a
`MenuItem` around a `UiMenuItem`:

```vue
<Menu as="div" class="relative">
  <MenuButton as="template"><UiButton size="xs">Focus on all</UiButton></MenuButton>
  <MenuItems class="menu absolute top-full right-0 z-40 mt-1.5 w-56">
    <MenuItem v-for="s in sessions" :key="s.id" v-slot="{active}" as="template">
      <UiMenuItem :lit="active" @click="focus(s)">{{ s.name }}</UiMenuItem>
    </MenuItem>
  </MenuItems>
</Menu>
```

`active` marks the current pick, `muted` a quieter line (Back, None), `danger` one that removes something, and `lit`
the line ↑↓ are on (Headless UI's `active`), drawn as a hover is.

### UiContextMenu

A menu at the pointer, for a right-click. Headless UI has none, so this is the one place that draws one: it keeps
the panel inside the window, takes the focus as it opens, and closes on Esc, a press outside it, or the window losing
focus or changing size.

```vue
<UiContextMenu :at="issue ? target : null" :label="`Actions for ${issue?.id}`" width="w-64" @close="close">
  <template v-if="issue">
    <UiMenuItem @click="copyId"><ClipboardIcon class="size-3.5 text-faint" /> Copy id</UiMenuItem>
    <UiMenuItem danger @click="confirming = true">Remove…</UiMenuItem>
  </template>
</UiContextMenu>
```

`at` is where the right-click was (`{x, y}`); nothing closes it. Its lines can change in place (a chunk list, a
confirm), as a Headless UI `Menu` can't: one closes on any pick.

### UiConfirm

Asking before removing something, in place of the button that asked: the question, then Remove and Cancel side by
side.

```vue
<UiConfirm v-if="confirming" :busy="busy" @confirm="remove" @cancel="confirming = false">
  Remove chunk {{ chunk.id }}? Its issues stay, in no chunk.
</UiConfirm>
```

Stacked, the two buttons share the width (in a menu). `inline` puts the question and the buttons on one line (a
toolbar, a comment), with `size="xs"` beside small text. `action` and `busyAction` change the button's words
(default Remove, Removing…). Esc cancels.

## Styles (`assets/css/main.css`)

Where a class is all it takes, it's a utility rather than a component:

| Utility | For |
|---|---|
| `glass` | the panel of anything floating over the page (dialogs, menus, toasts) |
| `menu` | a menu or popover: `glass` with the padding and column its `UiMenuItem`s need |
| `field` | a text field, select or text box: on the well, a ring that lights on focus. Its size goes beside it (`h-8 w-full field`) |
| `label` | the small uppercase heading over a group (PROPERTIES, WHEN) |
| `doc` | Markdown drawn as a page (through `MarkdownView`) |
| `unseen-row`, `unseen-dot` | changed since the owner last looked |

Colours come from the theme, never a fixed grey: `bg-canvas` (the page), `bg-panel` (sidebar, cards),
`bg-raised` (popovers), `bg-well` (fields, segmented controls), `border-line`, `text-fg` / `text-muted` /
`text-faint`, `bg-hover` / `bg-active` (rows), and the accent `accent-300…600`. Each has a light and a dark value,
and an orrery's tint mixes into the surfaces, so a fixed colour looks wrong in one of them.

## Shared components

Already one component each; use them rather than drawing the same thing again.

**Choosing**

| Component | For |
|---|---|
| `PropertyPicker` | a property as a button with a menu to type in (status, priority, chunk, release, assignee, labels with `multiple`). Use it rather than a native `<select>`; `field` draws it as a boxed field for a row of them in a form (New issue), and `field small` at a toolbar's height (the Schedules project filter). `PRIORITY_OPTIONS` and `chunkOptions(chunks)` (utils/roadmap) are the usual option lists |
| `SegmentedControl` | a choice of two to four shown side by side (List \| Board, issue \| message, a page's tabs): Headless UI's `RadioGroup`, one Tab stop with ←→ moving the choice |
| `FilterMenu` | a toolbar filter: a button with options to tick, empty meaning any: Headless UI's `Listbox` (`multiple`) |
| `LabelPicker` | a new issue's labels: tick the project's or make one, a `PropertyPicker` (`multiple`, `creatable`) |
| `SelectBox` | the tick on an issue's row or card, for changing many at once |

**Showing**

| Component | For |
|---|---|
| `StatusIcon` | a status as its icon, in its colour (`column`, `progress`, `size`) |
| `PriorityIcon` | P0…P3 as bars, or three dots for none |
| `ProgressRing` | done of all, as a ring and `12/20` (`bare` for the ring alone) |
| `LabelChip` | a label as a coloured dot and its name |
| `PersonAvatar` | an assignee's initials on their colour; Claude gets the accent |
| `ProjectIcon` | a project's Heroicon in its colour |
| `SectionIcon` | the icon of a project's page (issues, roadmap, docs…) |
| `SessionDot` | a Claude session's state as a dot |
| `KeyHint` | a key, as `<KeyHint>⌘↵</KeyHint>` |
| `StepMark` | a step's number in a guide, ticked when done |
| `MarkdownView` | Markdown as a page (descriptions, comments, docs); with `before`, what changed is tinted |
| `InlineText` | a line with inline `code`, **bold** and links |

**Copying and adding**

| Component | For |
|---|---|
| `CopyButton` | Copy, then Copied with a tick |
| `CopyBlock` | a titled block of text to copy as it is (a command, a config) |
| `ImageButton` | picks images for a Markdown field |

**Page frame**

| Component | For |
|---|---|
| `PageHeader` | a page's top bar: title, the page's controls, the bell, theme and settings |
| `ViewToolbar` | an issue list's toolbar (view, grouping, filters) |
| `NotFound` | what a page couldn't find (the slot), why that might be (`reason`) and a way back (`to`, `back`); it titles the tab "Not found". `error.vue` uses it for an unknown URL, inside the layout |
| `DocContents` | a doc's table of contents |
| `GettingStarted` | a new orrery's steps, ticked from live data (`useGettingStarted`): the first run as a page, `card` on My issues |
| `NotificationBell` | the bell in the header: agents' comments, and those and their proposals waiting on the owner |
| `ThemeToggle` | light ⇄ dark, following the system until one is picked |
| `OrreryMark` | the logo's mark, in `currentColor` |

**Dialogs**

The layout (`layouts/default.vue`) mounts the dialogs, each as `Lazy…` behind `openedOnce`: it loads the first
time it opens, in its own chunk, and then stays. A dialog is opened through the state its composable shares
(`useNewIssue`, `useNewChunk`, `useStartSession`, `useSchedules`), so any page or ⌘K can open it without
holding it. A new one goes in the same way, built on `UiDialog`. ⌘K's palette, the menus and the bulk bar are
mounted from the start, as they listen for keys or show on a right-click.

## Shared behaviour (`composables/`, `utils/`)

Auto-imported, like the components. Reach for these before writing the listener or the fetch again.

| | For |
|---|---|
| `useDismiss(element, isOpen, close, {capture?, blur?, resize?})` | closes something on a press outside it (and, if asked, when the window loses focus or resizes); only `UiContextMenu` needs it, as Headless UI's parts close themselves |
| `useHotkeys` | the page's keys (j/k, Enter, Esc, /, ⌘K, x, ⌘A); a row takes part by carrying `data-nav` |
| `useSelection` | the issues ticked for a change to many (`BulkBar`); rows carry `data-issue` and `data-project` |
| `useIssueLink` | an issue's page (`pathOf`, `open`), and the last one opened, marked when you come back |
| `useImageUpload(text, field)` | images pasted, dropped or picked into a Markdown field (with `ImageButton`) |
| `useUnseen` | what's changed since the owner last looked (`unseen-row`, `unseen-dot`) |
| `useTheme` | light, dark or the system's, remembered in this browser |
| `copyText` | copies text, with a fallback where the clipboard API refuses (`CopyButton` uses it) |
| `errorMessage(error, verb)` | what a failed request says to show: the server's message, or that orrery didn't answer |
| `isTyping(target)` | whether a key went to a field, where single-letter shortcuts mustn't fire |
| `heroicon(name)` | a project's Heroicon by name, each loaded the first time it's shown; `HEROICONS` lists the names for the picker |

## Adding to the set

A new component belongs in `components/ui/` when it's a building block with no idea of issues or projects
(a button, a dialog). One that knows the roadmap (a status, a session) goes beside the others in
`components/`. Either way, open it with a comment that says what it's for and what its props do, add it to
this page, and move the copies you found onto it in the same change.

Keys, focus and outside-click come from [Headless UI](https://headlessui.com/v1/vue) (`@headlessui/vue`) rather than
being written again in each component:

| Ours | Headless UI |
|---|---|
| `UiDialog` (every dialog, ⌘K), `ImageView` | `Dialog` |
| `PropertyPicker`, `LabelPicker` | `Combobox` |
| `FilterMenu` | `Listbox` |
| `SegmentedControl` | `RadioGroup` |
| `StatusFocus` | `Menu` |

Something new that opens, picks or closes builds on the matching part and only draws it, in the classes above. Two
things stay our own, as Headless UI (v1) has nothing that fits: the right-click menus (`UiContextMenu`), and ⌘K's
list, which jumps a section on ⇥ and opens "N more" in place (it says the same to a screen reader, as a combobox).
Folding (the sidebar's projects, a list's groups) stays a button with `aria-expanded`, since Headless UI's
`Disclosure` can't be opened or closed from outside, and the folds are kept between visits.
