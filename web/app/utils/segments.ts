// The look of orrery's tabs (docs/components.md): a well with a ring round it, each option a pill in the same weight,
// the chosen one filled with the accent. SegmentedControl draws its tabs with these, and so does a set of tabs that
// can't be one, such as the ⌘K palette's categories, where the focus stays in the input (ORR-991).
// A row too wide for the screen scrolls sideways instead of wrapping a label onto two lines (ORR-1157).
export const SEGMENTS = 'flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-well p-0.5 ring-1 ring-line [scrollbar-width:none]'

/** One option's classes: the same size and weight whether it's chosen or not, so choosing one moves nothing. */
export function segment(chosen: boolean) {
    return [
        'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/50',
        chosen ? 'bg-accent-fill text-on-accent shadow-sm focus-visible:ring-offset-1 focus-visible:ring-offset-well' : 'text-muted hover:text-fg',
    ]
}
