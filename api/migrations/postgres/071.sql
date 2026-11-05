
    -- A session's person (ORR-705): whoever's agent key it first reported with, so another person's key can't write as it.
    CREATE TABLE session_people (
        session text PRIMARY KEY,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE,
        at text NOT NULL
    );
