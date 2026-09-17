create policy ledger_event_door_operation on ledger_event
  for insert to hub_door
  with check (actor = 'door' and stream = 'operation' and kind in ('failed', 'read-restored'));

-- The door may request a machinery notice, never settle a model reply.
create function hub_door_notice(person_id text, agent_id text, body_text text, key_text text, pinned_route jsonb, part integer)
returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
  values ('notice', null, part, body_text, person_id, agent_id, key_text, pinned_route)
  on conflict (notice_key) do nothing;
$$;
alter function hub_door_notice(text, text, text, text, jsonb, integer) owner to hub_runner;
revoke all on function hub_door_notice(text, text, text, text, jsonb, integer) from public;
grant execute on function hub_door_notice(text, text, text, text, jsonb, integer) to hub_door;
