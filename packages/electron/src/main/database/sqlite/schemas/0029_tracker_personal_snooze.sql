-- Personal triage snooze: the epoch-ms deadline until which an item stays out
-- of this user's inbox. Personal, not team state -- one triager deferring an
-- item must not hide it from a colleague working the same shared tracker.
-- NULL means "not snoozed"; a past value simply expires on read.

ALTER TABLE tracker_personal_state ADD COLUMN snoozed_until INTEGER;
