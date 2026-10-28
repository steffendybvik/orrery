/** What a failed request says to show: the server's message (a 400 names the problem), or that orrery
 * didn't answer. `verb` is what was being done: `save`, `create`, `delete`. */
export function errorMessage(error: unknown, verb = 'save'): string {
    return (error as {data?: {message?: string}}).data?.message ?? `Couldn't ${verb} it. Is orrery running?`
}

/** Whether a key went to a field being typed in, where single-letter shortcuts mustn't fire. */
export function isTyping(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}
