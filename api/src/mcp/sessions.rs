// The MCP sessions `/mcp` has begun, and the tool groups each loaded with `more_tools` (ORR-1167). Kept in memory on
// `App`, as the phone's links are: a restart forgets them, and a session then lists its groups behind `more_tools` again.
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// How many sessions are kept: past it, the oldest is let go.
const KEPT: usize = 10_000;

#[derive(Default)]
struct Inner {
    /// Each session's loaded groups, in the order it loaded them.
    loaded: HashMap<String, Vec<String>>,
    /// The sessions in the order they began, so the oldest goes first.
    began: VecDeque<String>,
}

#[derive(Default)]
pub struct Sessions(Mutex<Inner>);

impl Sessions {
    /// A new session's id, given on `initialize`.
    pub(crate) fn begin(&self) -> String {
        self.begin_within(KEPT)
    }

    fn begin_within(&self, kept: usize) -> String {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).expect("the system's randomness");
        let id: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let mut inner = self.0.lock().expect("the MCP sessions");
        while inner.loaded.len() >= kept {
            let Some(oldest) = inner.began.pop_front() else { break };
            inner.loaded.remove(&oldest);
        }
        inner.loaded.insert(id.clone(), Vec::new());
        inner.began.push_back(id.clone());
        id
    }

    /// The groups `session` has loaded; none for no session or one this API doesn't know.
    pub(crate) fn loaded(&self, session: Option<&str>) -> Vec<String> {
        let Some(session) = session else { return Vec::new() };
        self.0.lock().expect("the MCP sessions").loaded.get(session).cloned().unwrap_or_default()
    }

    /// Keeps that `session` loaded `group`, once.
    pub(crate) fn load(&self, session: Option<&str>, group: &str) {
        let Some(session) = session else { return };
        if let Some(groups) = self.0.lock().expect("the MCP sessions").loaded.get_mut(session) {
            if !groups.iter().any(|g| g == group) {
                groups.push(group.to_string());
            }
        }
    }

    /// Lets a session go (`DELETE /mcp`): whether it was one.
    pub(crate) fn end(&self, session: &str) -> bool {
        let mut inner = self.0.lock().expect("the MCP sessions");
        if inner.loaded.remove(session).is_none() {
            return false;
        }
        inner.began.retain(|id| id != session);
        true
    }
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
