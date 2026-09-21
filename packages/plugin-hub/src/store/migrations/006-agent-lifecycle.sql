-- The hub says the outcome of a lifecycle control in the chat it was asked in.
--
-- The hub applies those controls because it is the only process that writes the
-- registry, and it owns no insert on `outbox` and never will. So it is granted
-- the security-definer function the door already asks its own notices with:
-- that function writes one keyed machinery notice with a pinned route and
-- nothing else, `on conflict do nothing` makes a replay say it once, and there
-- is no shape of call through it that produces a reply. Granting the table
-- instead would hand the hub every row of the outbox for one sentence.
grant execute on function hub_door_notice(text, text, text, text, jsonb, integer) to hub_hub;
