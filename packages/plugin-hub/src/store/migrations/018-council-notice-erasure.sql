-- Notices routed to General still belong to the source topic. Match complete key
-- components (including split notices), never a display name or fuzzy prefix.
create function hub_erasure_owns_notice(topic_in text, key_in text, councils_in text[]) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select coalesce(starts_with(key_in, 'topic:attention-catchup:' || topic_in || ':')
    or (split_part(key_in, ':', 1) in
          ('council-missing','council-checkpoint','council-correction','council-master','council-legacy','council-status')
        and split_part(key_in, ':', 2) = any(councils_in))
    or (split_part(key_in, ':', 1) in ('council-quiet','council-overrun')
        and exists (select 1 from public.council_participant p
          where p.id = split_part(key_in, ':', 2) and p.council_id = any(councils_in))), false)
$$;
revoke all on function hub_erasure_owns_notice(text, text, text[]) from public;
grant execute on function hub_erasure_owns_notice(text, text, text[]) to hub_door, hub_runner, hub_hub;


create or replace function hub_deletion_inventory(agent_in text, conversation_in text, workers_in jsonb, person_in text, door_in text,
                                       chat_in text, topic_in text) returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  s public.erasure_sets;
begin
  s := public.hub_erasure_sets(agent_in, conversation_in, workers_in);
  return jsonb_build_object(
    'conversations', (select count(*) from public.conversation where id = any (s.conversations)),
    'conversation_entries', (select count(*) from public.conversation_entry where conversation_id = any (s.conversations)),
    'inbound', cardinality(s.inbound),
    'jobs', (select count(*) from public.inbound where id = any (s.inbound) and kind = 'job'),
    'executions', cardinality(s.executions),
    'councils', cardinality(s.councils),
    'outbox', (select count(*) from public.outbox where inbound_id = any (s.inbound) or agent = agent_in
      or public.hub_erasure_owns_notice(topic_in, notice_key, s.councils)),
    'media_files', (select count(*) from public.media where inbound_id = any (s.inbound)),
    'media_bytes', (select coalesce(sum(octet_length(bytes)), 0) from public.media where inbound_id = any (s.inbound)),
    'ledger_events', (select count(*) from public.ledger_event
                       where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
                          or subject = any (s.conversations) or subject = agent_in),
    'state_rows', (select count(*) from public.state_row r
                    where public.hub_erasure_owns_row(r.sheet, r.id, r.data, agent_in, person_in, door_in, chat_in, s.inbound)),
    'moves', cardinality(s.moves),
    'move_copies', (select count(*) from public.move_copy where move_id = any (s.moves) and state not in ('removed', 'superseded')),
    'effects_in_chat', (select count(*) from public.platform_effect e where chat_in is not null and e.door = door_in and e.chat = chat_in),
    'messages_elsewhere', (select count(*) from public.hub_erasure_linked_effects(topic_in, agent_in, s.councils) e
                            where e.platform_id is not null and not (e.door = door_in and coalesce(e.chat = chat_in, false)))
  );
end $$;

create or replace function hub_erase_scope(topic_in text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
  n integer;
  counts jsonb := '{}'::jsonb;
  stops jsonb;
  left_over bigint;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    raise exception 'erase-unknown: topic % has no tombstone, and nothing is erased without one', topic_in;
  end if;
  perform set_config('hub.erasing', k.deletion_id, true);
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);

  select coalesce(jsonb_agg(jsonb_build_object('target', r.target_kind || ':' || r.target_id, 'state', r.state, 'outcome', r.outcome) order by r.id), '[]'::jsonb)
    into stops from public.stop_request r where r.operation_id = 'delete:' || k.deletion_id;
  update public.topic_deletion set quiesce = jsonb_build_object('stops', stops), updated_at = now() where id = k.deletion_id;

  delete from public.source_consumption where conversation_id = any (s.conversations) or source_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('source_consumption', n);
  delete from public.tool_invocation where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('tool_invocation', n);
  delete from public.stop_request
   where execution_id = any (s.executions) or conversation_id = any (s.conversations) or agent = k.agent_id
      or (target_kind = 'agent' and target_id = k.agent_id)
      or (target_kind = 'conversation' and target_id = any (s.conversations));
  get diagnostics n = row_count; counts := counts || jsonb_build_object('stop_request', n);
  delete from public.replay_hold
   where inbound_id = any (s.inbound) or conversation_id = any (s.conversations) or execution_id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('replay_hold', n);
  delete from public.execution where id = any (s.executions);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('executions', n);
  delete from public.conversation_entry where conversation_id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversation_entries', n);

  -- The messages and the frozen proposals are found THROUGH the councils and the confirmations, so they go before either does.
  delete from public.platform_effect e
   where (k.chat is not null and e.door = k.door and e.chat = k.chat)
      or e.key in (select l.key from public.hub_erasure_linked_effects(k.topic_id, k.agent_id, s.councils) l);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('platform_effects', n);
  delete from public.confirmation cf where cf.id in (select x from public.hub_erasure_confirmations(k.topic_id, k.agent_id, s.councils) x);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('confirmations', n);

  delete from public.outbox where inbound_id = any (s.inbound) or agent = k.agent_id
     or public.hub_erasure_owns_notice(k.topic_id, notice_key, s.councils);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('outbox', n);

  delete from public.council_event where council_id = any (s.councils);
  delete from public.round_member where council_id = any (s.councils);
  delete from public.council_round where council_id = any (s.councils);
  delete from public.council_decision where council_id = any (s.councils);
  delete from public.council_participant where council_id = any (s.councils);
  delete from public.council where id = any (s.councils);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('councils', n);

  delete from public.move_blob where move_id = any (s.moves);
  delete from public.move_copy where move_id = any (s.moves);
  delete from public.topic_move where id = any (s.moves);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('moves', n);

  delete from public.media where inbound_id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('media', n);
  delete from public.ledger_event
   where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
      or subject = any (s.conversations) or subject = k.agent_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('ledger_events', n);
  delete from public.inbound where id = any (s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('inbound', n);
  delete from public.conversation where id = any (s.conversations);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('conversations', n);

  delete from public.state_row r
   where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound);
  get diagnostics n = row_count; counts := counts || jsonb_build_object('state_rows', n);

  delete from public.topic_transition where topic_id = k.topic_id;
  delete from public.topic_channel_seen where topic_id = k.topic_id;
  delete from public.topic where id = k.topic_id;
  get diagnostics n = row_count; counts := counts || jsonb_build_object('topic', n);

  select (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound))
       + (select count(*) from public.inbound where id = any (s.inbound))
    into left_over;
  if left_over > 0 then
    raise exception 'erase-incomplete: % rows of topic % are still there', left_over, topic_in;
  end if;
  perform set_config('hub.erasing', '', true);
  return counts;
end $$;

create or replace function hub_erasure_remaining(topic_in text) returns bigint
language plpgsql stable security definer set search_path = pg_catalog, public as $$
declare
  k public.topic_tombstone%rowtype;
  s public.erasure_sets;
begin
  select * into k from public.topic_tombstone where topic_id = topic_in;
  if not found then
    return 0;
  end if;
  s := public.hub_erasure_sets(k.agent_id, k.conversation_id, k.worker_conversations);
  return (select count(*) from public.outbox where inbound_id = any(s.inbound) or agent = k.agent_id
           or public.hub_erasure_owns_notice(k.topic_id, notice_key, s.councils))
       + (select count(*) from public.topic where id = k.topic_id)
       + (select count(*) from public.conversation where id = any (s.conversations))
       + (select count(*) from public.inbound where id = any (s.inbound))
       + (select count(*) from public.execution where id = any (s.executions))
       + (select count(*) from public.council where id = any (s.councils))
       + (select count(*) from public.topic_move where id = any (s.moves))
       + (select count(*) from public.ledger_event
           where subject = any (s.inbound) or subject = any (s.executions) or subject = any (s.councils)
              or subject = any (s.conversations) or subject = k.agent_id)
       + (select count(*) from public.state_row r
           where public.hub_erasure_owns_row(r.sheet, r.id, r.data, k.agent_id, k.person, k.door, k.chat, s.inbound));
end $$;

create or replace function hub_topic_attention_catchup(topic_in text, represented jsonb, notice jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  t public.topic%rowtype;
  one jsonb;
  named text;
begin
  select * into t from public.topic where id = topic_in for update;
  if not found then
    return 'unknown-topic';
  end if;
  if represented is null or jsonb_typeof(represented) <> 'array' or jsonb_array_length(represented) = 0 or notice is null then
    return 'nothing';
  end if;
  -- Eligibility is checked under the same lock as queueing and deletion confirmation.
  for one in select e from jsonb_array_elements(represented) e loop
    if starts_with(one ->> 'kind', 'council-') and
       (t.lifecycle = 'deleting' or not exists (
         select 1 from public.council c where c.return_route ->> 'door' = t.door
           and c.return_route ->> 'chat' = t.chat
           and left(encode(sha256(convert_to(c.id, 'UTF8')), 'hex'), 12) = split_part(one ->> 'kind', '-', 3))) then
      update public.topic set create_evidence = create_evidence #- array['attention', one ->> 'kind'] where id = t.id;
      return 'stale';
    end if;
  end loop;
  for one in select e from jsonb_array_elements(represented) e loop
    if coalesce((t.create_evidence #>> array['attention', one ->> 'kind', 'seq'])::integer, -1)
         is distinct from coalesce((one ->> 'seq')::integer, -2) then
      return 'stale';
    end if;
  end loop;
  select string_agg((e ->> 'kind') || '.' || (e ->> 'seq'), ',' order by e ->> 'kind') into named
    from jsonb_array_elements(represented) e;
  insert into public.outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
  values ('notice', null, 1, notice ->> 'body', notice ->> 'person', notice ->> 'agent',
          'topic:attention-catchup:' || t.id || ':' || named, notice -> 'route')
  on conflict (notice_key) do nothing;
  for one in select e from jsonb_array_elements(represented) e loop
    update public.topic set create_evidence = create_evidence #- array['attention', one ->> 'kind'] where id = t.id;
  end loop;
  return 'queued';
end $$;

-- Lock before a watcher checks whether another task already paid this need.
create function hub_topic_attention_lock(topic_in text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare state text;
begin
  select lifecycle into state from public.topic where id = topic_in for update;
  return state;
end $$;
revoke all on function hub_topic_attention_lock(text) from public;
grant execute on function hub_topic_attention_lock(text) to hub_door, hub_runner, hub_hub;

-- Hold the source topic and council until direct notices commit, so deletion
-- cannot remove their provenance while a watcher queues a notice in General.
create function hub_council_notice_lock(council_in text) returns boolean
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  c public.council%rowtype;
  state text;
begin
  select * into c from public.council where id = council_in;
  if not found then return false; end if;
  select lifecycle into state from public.topic
    where door = c.return_route ->> 'door' and chat = c.return_route ->> 'chat' for update;
  if found and state = 'deleting' then return false; end if;
  perform 1 from public.council where id = council_in for key share;
  return found;
end $$;
revoke all on function hub_council_notice_lock(text) from public;
grant execute on function hub_council_notice_lock(text) to hub_door, hub_runner, hub_hub;
