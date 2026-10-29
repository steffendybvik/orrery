// A write from an untrusted schedule's session (its channel's tools send `Orrery-Untrusted: yes`, and `Orrery-Session`;
// it has no other way to reach orrery) is held to the permissions table's untrusted column (`guard`, ORR-512), whether or
// not orrery knows its launch (it may have restarted since): raising proposals (its new issue is made one, labelled
// `external`, by its route) and commenting on such proposals (the cell's `externalProposal`). Anything else it tries is
// refused, so what it read can't steer it into changing the roadmap, the docs or a secret's use.
import {guard} from '../utils/guard'

export default defineEventHandler(async event => {
    if (!untrustedWrite(event)) return
    await guard(event, 'untrusted', 'This session reads what others wrote (an untrusted schedule), so it only raises proposals (create_issue) and comments on them')
})
