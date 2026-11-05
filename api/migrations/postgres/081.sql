
    -- A schedule's own model and effort (ORR-869): what its session starts on, its message needs, and its issues carry.
    -- None takes its kind's.
    ALTER TABLE schedules ADD COLUMN model text;
    ALTER TABLE schedules ADD COLUMN effort text;
