import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "../context/ThemeContext";

// Line chart for the 24H view (raw samples), bars for the bucketed 7D/30D
// views — matching how the mobile app presents each range.

function ChartTooltip({ active, payload, label, unit, compareLabel }) {
  if (!active || !payload?.length) return null;
  // With a comparison series there are two entries and the single-value
  // layout stops being readable -- name each one instead.
  if (compareLabel && payload.length > 1) {
    return (
      <div className="chart-tip">
        <div className="chart-tip-label">{label}</div>
        {payload.map((p) => (
          <div key={p.dataKey} className="chart-tip-value" style={{ color: p.color }}>
            {p.name}: {p.value == null ? "—" : `${Number(p.value).toFixed(2)}${unit}`}
          </div>
        ))}
      </div>
    );
  }
  const p = payload[0];
  return (
    <div className="chart-tip">
      <div className="chart-tip-label">{label}</div>
      <div className="chart-tip-value" style={{ color: p.payload.color }}>
        {Number(p.value).toFixed(2)}{unit}
      </div>
    </div>
  );
}

// onBarClick (bucketed 7D/30D views only) receives the clicked datum, so the
// caller can drill into the individual readings behind that bucket average.
// The 24H line view is already per-reading, so there is nothing to drill into.
// compareLabel turns on a second series drawn from each point's
// `compareValue` -- used to chart a paired LoRaWAN device's other half
// alongside this one. Absent, the chart behaves exactly as before.
export default function TrendChart({ data, metric, isLine, height = 300, onBarClick,
                                     compareLabel, primaryLabel }) {
  const { theme } = useTheme();

  if (!data.length) {
    return (
      <div className="empty" style={{ height }}>
        <div className="empty-icon"><span style={{ fontSize: 22 }}>📊</span></div>
        <div style={{ fontWeight: 700, color: "var(--text)" }}>No data for this period</div>
        <div className="hint">Try a wider range, or step back with the arrows above.</div>
      </div>
    );
  }

  const values = data.flatMap((d) => (
    compareLabel ? [d.value, d.compareValue] : [d.value]
  )).filter((v) => v != null && !isNaN(v));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.2 || 1;

  const axis = { stroke: theme.subtext, fontSize: 11, fontWeight: 600 };
  const domain = [
    isLine ? Math.max(0, min - pad) : Math.max(0, min - pad * 2),
    max + pad,
  ];

  const common = (
    <>
      <CartesianGrid strokeDasharray="4 4" stroke={theme.divider} vertical={false} />
      <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={{ stroke: theme.divider }} interval="preserveStartEnd" minTickGap={28} />
      <YAxis
        tick={axis} tickLine={false} axisLine={false} width={62} domain={domain}
        tickFormatter={(v) => `${v.toFixed(metric.decimals >= 3 ? 2 : 1)}${metric.unit}`}
      />
      <Tooltip
        content={<ChartTooltip unit={metric.unit} compareLabel={compareLabel} />}
        cursor={{ fill: theme.divider, opacity: 0.45 }}
      />
      {compareLabel && (
        <Legend verticalAlign="top" height={26} iconType="plainline"
                wrapperStyle={{ fontSize: 11.5, fontWeight: 600 }} />
      )}
    </>
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      {isLine ? (
        <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          <defs>
            <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={metric.color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={metric.color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {common}
          {compareLabel && (
            <Area
              type="monotone" dataKey="compareValue" name={compareLabel}
              stroke={theme.subtext} strokeWidth={1.6} strokeDasharray="5 4"
              fill="none" dot={false} isAnimationActive={false} connectNulls
            />
          )}
          <Area
            name={primaryLabel || "This device"}
            type="monotone" dataKey="value"
            stroke={metric.color} strokeWidth={2}
            fill="url(#areaFill)"
            dot={(props) => {
              const { cx, cy, payload, index } = props;
              // Only mark statistical outliers, like the mobile chart does.
              if (!payload.anomaly) return <g key={index} />;
              return <circle key={index} cx={cx} cy={cy} r={4} fill={payload.color} stroke="#fff" strokeWidth={1.5} />;
            }}
            activeDot={{ r: 5, fill: metric.color, stroke: "#fff", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </AreaChart>
      ) : (
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
          {common}
          {compareLabel && (
            <Bar dataKey="compareValue" name={compareLabel} radius={[7, 7, 0, 0]}
                 maxBarSize={54} isAnimationActive={false} fill={theme.subtext} fillOpacity={0.45} />
          )}
          <Bar
            name={primaryLabel || "This device"}
            dataKey="value" radius={[7, 7, 0, 0]} maxBarSize={54} isAnimationActive={false}
            onClick={onBarClick ? (d) => onBarClick(d?.payload ?? d) : undefined}
            cursor={onBarClick ? "pointer" : undefined}
          >
            {data.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Bar>
        </BarChart>
      )}
    </ResponsiveContainer>
  );
}
