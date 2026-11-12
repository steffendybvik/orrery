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
mod tests {
    use super::*;

    fn said(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(*name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    #[test]
    fn lists_are_joined_in_order_and_a_single_value_is_the_last_calls() {
        let relay = Relay::default();
        relay.keep(&said(&[("orrery-carry", "alpha ALP-1 3"), ("orrery-asked", "first"), ("orrery-api-token", "secret")]));
        relay.keep(&said(&[("orrery-carry", "alpha ALP-2 4"), ("orrery-asked", "second"), ("orrery-changed", "")]));
        let mut out = HeaderMap::new();
        relay.onto(&mut out);
        assert_eq!(out.get("orrery-carry").unwrap(), "alpha ALP-1 3, alpha ALP-2 4");
        assert_eq!(out.get("orrery-asked").unwrap(), "second");
        assert!(out.get("orrery-changed").is_none(), "an empty list says nothing");
        assert!(out.get("orrery-api-token").is_none(), "only what a write set off is handed back");
    }
}
