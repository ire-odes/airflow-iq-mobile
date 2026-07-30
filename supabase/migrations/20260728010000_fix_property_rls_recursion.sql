-- Fixes: "infinite recursion detected in policy for relation properties".
--
-- Cause: "property technicians read assigned properties" (on properties)
-- queries property_technician_assignments, whose own "owners manage..."
-- policy queried properties right back — a circular RLS reference that
-- Postgres refuses to evaluate, failing the query for every user, owners
-- included (which is why the app reported the table as "not set up").
--
-- Fix: the ownership check runs through a SECURITY DEFINER function, which
-- executes as its (superuser) owner and so bypasses RLS internally instead
-- of re-entering the properties policy.

create or replace function public.is_property_owner(p_property_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.properties p
    where p.id = p_property_id and p.owner_id = auth.uid()
  );
$$;

drop policy if exists "owners manage property technician assignments" on public.property_technician_assignments;
create policy "owners manage property technician assignments"
  on public.property_technician_assignments for all
  using (public.is_property_owner(property_id))
  with check (public.is_property_owner(property_id));
