
    -- A preset's badge: a Heroicon and a colour (a tint's name or #rrggbb); without an icon, its initials.
    ALTER TABLE presets ADD COLUMN icon TEXT;
    ALTER TABLE presets ADD COLUMN color TEXT;
