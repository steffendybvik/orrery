    -- Which sessions are there to hear, on which projects (ORR-1172): the Nuxt server, which their channels connect to,
    -- says so as each connects or goes (PUT/DELETE /api/session-presence/:session) and again every half minute, so the
    -- rails can tell whether a claim on an issue still holds. One not said again in 90 seconds is taken as gone, so a
    -- session that dies without a goodbye, or a Nuxt server that stops, frees its issues. No workspace: it's read by
    -- project, which has one.
    CREATE TABLE session_presence (
        session TEXT NOT NULL,
        project TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (session, project)
    );
