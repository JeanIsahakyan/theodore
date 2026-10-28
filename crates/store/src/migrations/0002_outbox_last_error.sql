-- Why an outbox item's last attempt failed (the host's message), kept so a
-- failed or still-retrying write can say what went wrong.
ALTER TABLE outbox ADD COLUMN last_error TEXT;
