import {AsyncLocalStorage} from 'node:async_hooks'

/** Set while orrery records an answer of the owner's that asks no session for work (ORR-606): a schedule request on an
 * issue allowed or denied, a proposal rejected. Its comment still reaches the session on the issue, or one listening,
 * but starts none, so a click on Allow doesn't take one of the limit's sessions. */
export const startsNone = new AsyncLocalStorage<boolean>()
