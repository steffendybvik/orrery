// What the routes a `/mcp` request ran set off, handed back on its own reply (ORR-1102). A board tool runs a route inside
// this API (board.rs), so the `orrery-*` headers that route answers with (reply.rs) would stop there. The Nuxt router
// reads them off `/mcp`'s reply as it reads them off any route's (`relayed` in api-router.ts): a comment passed on to its
// session and the bell (`orrery-carry`, `orrery-notice`), an urgent push (`orrery-urgent`), the event log's lines for
// a schedule's ask and answer, and what the outbox says too, for a server not following it.
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use std::sync::Mutex;

/// Lists, apart by commas: what each call says is kept, after the ones before.
const LISTS: [&str; 7] = ["orrery-changed", "orrery-schedules", "orrery-settings-keys", "orrery-told", "orrery-carry", "orrery-notice", "orrery-urgent"];
/// One value: the last call's stands. `orrery-settings` and `orrery-epics` are only ever `1`; a schedule's ask or answer
/// is one per call, and a session asks one at a time.
const ONES: [&str; 4] = ["orrery-settings", "orrery-epics", "orrery-asked", "orrery-answered"];

/// The headers gathered over one `/mcp` request.
#[derive(Default)]
pub(crate) struct Relay(Mutex<HeaderMap>);

impl Relay {
    /// Keeps what one route's reply set off.
    pub(crate) fn keep(&self, said: &HeaderMap) {
        let mut kept = self.0.lock().expect("the relayed headers");
        for name in LISTS {
            let Some(value) = said.get(name).and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty()) else { continue };
            let joined = match kept.get(name).and_then(|v| v.to_str().ok()) {
                Some(before) => format!("{before}, {value}"),
                None => value.to_string(),
            };
            if let Ok(joined) = HeaderValue::from_str(&joined) {
                kept.insert(HeaderName::from_static(name), joined);
            }
        }
        for name in ONES {
            if let Some(value) = said.get(name) {
                kept.insert(HeaderName::from_static(name), value.clone());
            }
        }
    }

    /// Puts what was kept on the `/mcp` reply.
    pub(crate) fn onto(self, headers: &mut HeaderMap) {
        for (name, value) in self.0.into_inner().expect("the relayed headers") {
            if let Some(name) = name {
                headers.insert(name, value);
            }
        }
    }
}

#[cfg(test)]
#[path = "relay_tests.rs"]
mod tests;
