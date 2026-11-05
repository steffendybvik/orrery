
    -- A proposal's choices (a JSON list): questions the owner answers by picking one option, or any, with the
    -- agent's recommendation ticked. The owner's picks when they approve (a JSON object, choice → options), or
    -- the option they asked to explore further when they ask for changes (a JSON {choice, option}).
    ALTER TABLE issues ADD COLUMN choices TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE issues ADD COLUMN picks TEXT;
    ALTER TABLE issues ADD COLUMN explore TEXT;
