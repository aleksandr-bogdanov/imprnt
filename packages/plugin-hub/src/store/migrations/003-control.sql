create policy ledger_event_control_request on ledger_event
  for insert to hub_door, hub_hub
  with check (stream = 'control' and kind = 'recovery.requested'
    and actor = case current_user when 'hub_door' then 'door' else 'hub' end);
create policy ledger_event_control_applied on ledger_event
  for insert to hub_runner, hub_hub
  with check (stream = 'control' and kind in ('recovery.applied', 'recovery.refused')
    and actor = case current_user when 'hub_runner' then 'runner' else 'hub' end);
