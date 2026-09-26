-- A council: one question, one job per seat, one merged answer.
--
-- The door convenes it and says so in the diary, one line for the council
-- beside the `dispatch.requested` line each seat's job already gets. A SECOND
-- policy beside the shipped ones rather than a widening of them, for the
-- reason the dispatch policies give: PostgreSQL ORs permissive policies, so
-- this is purely additive and each fence stays readable as one sentence.
create policy ledger_event_control_council_request on ledger_event
  for insert to hub_door, hub_hub
  with check (stream = 'control' and kind = 'council.requested'
    and actor = case current_user when 'hub_door' then 'door' else 'hub' end);
