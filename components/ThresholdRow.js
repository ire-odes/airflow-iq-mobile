// components/ThresholdRow.js
// Updated ThresholdRow that persists thresholds to AsyncStorage
// Replace the ThresholdRow component inside account.js with this

import React, { useState, useEffect } from "react";
import { View, Text, TextInput, StyleSheet, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { saveThresholds, loadThresholds } from "../lib/notifications";

export function ThresholdRow({ metric, theme }) {
  const [min, setMin] = useState(`${metric.defaultMin}`);
  const [max, setMax] = useState(`${metric.defaultMax}`);
  const [enabled, setEnabled] = useState(false);

  // Load saved values on mount
  useEffect(() => {
    loadThresholds().then((saved) => {
      if (saved[metric.key]) {
        setEnabled(saved[metric.key].enabled ?? false);
        setMin(`${saved[metric.key].min ?? metric.defaultMin}`);
        setMax(`${saved[metric.key].max ?? metric.defaultMax}`);
      }
    });
  }, []);

  // Persist any change
  const persist = async (newEnabled, newMin, newMax) => {
    const current = await loadThresholds();
    current[metric.key] = {
      enabled: newEnabled,
      min: newMin,
      max: newMax,
    };
    await saveThresholds(current);
  };

  const handleToggle = (val) => {
    setEnabled(val);
    persist(val, min, max);
  };

  const handleMinChange = (val) => {
    setMin(val);
    persist(enabled, val, max);
  };

  const handleMaxChange = (val) => {
    setMax(val);
    persist(enabled, min, val);
  };

  return (
    <View style={[row.container, { borderBottomColor: theme.divider }]}>
      <View style={[row.iconBg, { backgroundColor: metric.color + "20" }]}>
        <Ionicons name={metric.icon} size={16} color={metric.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[row.label, { color: theme.text }]}>{metric.label}</Text>
        {enabled && (
          <View style={row.inputs}>
            <View style={row.inputWrap}>
              <Text style={[row.inputLabel, { color: theme.subtext }]}>Min</Text>
              <TextInput
                style={[row.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                value={min}
                onChangeText={handleMinChange}
                keyboardType="numeric"
                onBlur={() => persist(enabled, min, max)}
              />
              <Text style={[row.inputUnit, { color: theme.subtext }]}>{metric.unit}</Text>
            </View>
            <View style={row.inputWrap}>
              <Text style={[row.inputLabel, { color: theme.subtext }]}>Max</Text>
              <TextInput
                style={[row.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
                value={max}
                onChangeText={handleMaxChange}
                keyboardType="numeric"
                onBlur={() => persist(enabled, min, max)}
              />
              <Text style={[row.inputUnit, { color: theme.subtext }]}>{metric.unit}</Text>
            </View>
          </View>
        )}
      </View>
      <Switch
        value={enabled}
        onValueChange={handleToggle}
        trackColor={{ false: "#e5e7eb", true: metric.color + "80" }}
        thumbColor={enabled ? metric.color : "#fff"}
      />
    </View>
  );
}

const row = StyleSheet.create({
  container: { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, borderBottomWidth: 1 },
  iconBg: { width: 32, height: 32, borderRadius: 10, justifyContent: "center", alignItems: "center" },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 4 },
  inputs: { flexDirection: "row", gap: 12, marginTop: 4 },
  inputWrap: { flexDirection: "row", alignItems: "center", gap: 4 },
  inputLabel: { fontSize: 11, fontWeight: "600" },
  input: { width: 70, borderWidth: 1, borderRadius: 8, padding: 6, fontSize: 13, fontWeight: "600", textAlign: "center" },
  inputUnit: { fontSize: 11 },
});