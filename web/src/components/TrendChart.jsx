import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { useTheme } from "../context/ThemeContext";

// Line chart for the 24H view (raw samples), bars for the bucketed 7D/30D
// views — matching how the mobile app presents each range.

function ChartTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
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
export default function TrendChart({ data, metric, isLine, height = 300, onBarClick }) {
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

  const values = data.map((d) => d.value);
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
        content={<ChartTooltip unit={metric.unit} />}
        cursor={{ fill: theme.divider, opacity: 0.45 }}
      />
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
          <Area
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
          <Bar
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
