// Shared definition of what counts as a paired blower/filter set.
//
// Lives here rather than in Devices.jsx because two views now draw pairs --
// the card grid and the device tree -- and a pair that groups in one view but
// not the other would look like a data bug rather than a rendering difference.

// Collapses a property's devices into render entries, so a paired
// blower/filter set can be drawn as one linked unit rather than two items
// that happen to sit near each other.
//
// Only pairs when BOTH halves are in the list passed in -- paired devices
// should share a property now that saveDevice mirrors property_id, but a pair
// created before that, or mid-edit, can still straddle two properties. Those
// fall back to rendering individually rather than vanishing from one list.
//
// Blower is placed first so the pair always reads upstream-to-downstream,
// matching airflow, regardless of insertion order.
export function groupPairs(devices) {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const used = new Set();
  const out = [];

  for (const d of devices) {
    if (used.has(d.id)) continue;
    const partner = d.paired_device_id ? byId.get(d.paired_device_id) : null;
    // Require the link to point back, so a stale one-sided paired_device_id
    // cannot swallow an unrelated device into a pair.
    if (partner && partner.paired_device_id === d.id && !used.has(partner.id)) {
      used.add(d.id); used.add(partner.id);
      const blower = d.duct_role === "blower" ? d : partner;
      const filter = blower === d ? partner : d;
      out.push({ kind: "pair", blower, filter });
    } else {
      used.add(d.id);
      out.push({ kind: "single", device: d });
    }
  }
  return out;
}
