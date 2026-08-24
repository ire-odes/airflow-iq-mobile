-- ============================================================================
-- Fix high Disk IO on sensor_logs (Supabase flagged the project for
-- depleting its Disk IO Budget).
--
-- Root cause: get_chart_data() used row_to_json(sensor_logs)->>p_metric to
-- dynamically pick a column -- this serializes every column of every row
-- into JSON, done up to 4x per row (once in WHERE, once each for
-- AVG/MIN/MAX). That's expensive enough that Postgres abandons
-- idx_sensor_logs_device_time and sequentially scans the table instead --
-- confirmed live: 3,215 seq scans reading ~148M rows cumulatively against
-- an 85K-row table. This dashboard chart function is called on every
-- 7D/30D chart load, for every device in scope.
--
-- Fix: dispatch to the real column via CASE instead of JSON, in a subquery
-- so the WHERE clause (device_id/recorded_at, matching the composite
-- index) isn't entangled with the per-row column lookup. p_metric values
-- come from web/src/lib/metrics.js's METRICS list (temp_c, humidity,
-- pressure_pa, windSpeed) -- a closed, known set, not user text reaching
-- SQL dynamically (this is a CASE, not EXECUTE format()).
--
-- Also drops idx_logs_device_time, an exact duplicate of
-- idx_sensor_logs_device_time -- every insert into sensor_logs (the
-- highest-write table, 12 devices posting continuously) was maintaining
-- both for no benefit.
--
-- Run this once in the Supabase Dashboard -> SQL Editor.
-- ============================================================================

create or replace function public.get_chart_data(
  p_device_ids uuid[], p_metric text, p_start timestamptz, p_end timestamptz, p_bucket text
)
returns table(bucket timestamptz, avg_val double precision, min_val double precision, max_val double precision)
language sql
as $function$
  select
    date_trunc(p_bucket, recorded_at) as bucket,
    avg(v) as avg_val,
    min(v) as min_val,
    max(v) as max_val
  from (
    select
      recorded_at,
      case p_metric
        when 'temp_c'      then temp_c
        when 'humidity'    then humidity
        when 'pressure_pa' then pressure_pa
        when 'windSpeed'   then "windSpeed"
        else null
      end as v
    from public.sensor_logs
    where device_id = any(p_device_ids)
      and recorded_at >= p_start
      and recorded_at <= p_end
  ) s
  where v is not null
  group by bucket
  order by bucket;
$function$;

drop index if exists public.idx_logs_device_time;
