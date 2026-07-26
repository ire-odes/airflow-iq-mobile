import React, { useState, useCallback } from "react";
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator, RefreshControl,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "expo-router";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { fetchProducts, fetchOrders, startDeviceCheckout, formatMoney } from "../../lib/billing";

let Haptics = null;
try { Haptics = require("expo-haptics"); } catch (_) {}
const haptic = () => { try { Haptics?.impactAsync(Haptics.ImpactFeedbackStyle?.Light); } catch (_) {} };

const STATUS_STYLES = {
  pending:   { color: "#f59e0b", icon: "time-outline",            label: "Awaiting payment" },
  paid:      { color: "#22c55e", icon: "checkmark-circle-outline", label: "Paid" },
  shipped:   { color: "#3b82f6", icon: "airplane-outline",         label: "Shipped" },
  delivered: { color: "#22c55e", icon: "cube-outline",             label: "Delivered" },
  canceled:  { color: "#ef4444", icon: "close-circle-outline",     label: "Canceled" },
};

// Collapse the fulfillment pipeline (order → invoice → shipment) into one badge
function effectiveStatus(order) {
  const f = order.fulfillment;
  if (f?.delivered_at || f?.shipment_status === "delivered") return "delivered";
  if (f?.shipment_status === "shipped" || f?.tracking_number) return "shipped";
  if (["canceled", "cancelled"].includes(order.status)) return "canceled";
  if (order.payment_status === "paid" || f?.paid_at || order.status === "submitted") return "paid";
  return "pending"; // draft orders awaiting checkout
}

function ProductCard({ product, quantity, onAdd, onRemove, theme }) {
  return (
    <View style={[styles.productCard, { backgroundColor: theme.card }]}>
      <View style={[styles.productIcon, { backgroundColor: theme.inputBg }]}>
        <Ionicons name="hardware-chip" size={26} color="#007BFF" />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.productName, { color: theme.text }]}>{product.name}</Text>
        {product.description ? (
          <Text style={[styles.productDesc, { color: theme.subtext }]} numberOfLines={2}>{product.description}</Text>
        ) : null}
        <Text style={styles.productPrice}>{formatMoney(product.price_cents, product.currency)}</Text>
      </View>
      {quantity > 0 ? (
        <View style={[styles.qtyControls, { backgroundColor: theme.inputBg }]}>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => { haptic(); onRemove(product); }}>
            <Ionicons name="remove" size={16} color="#007BFF" />
          </TouchableOpacity>
          <Text style={[styles.qtyText, { color: theme.text }]}>{quantity}</Text>
          <TouchableOpacity style={styles.qtyBtn} onPress={() => { haptic(); onAdd(product); }}>
            <Ionicons name="add" size={16} color="#007BFF" />
          </TouchableOpacity>
        </View>
      ) : (
        <TouchableOpacity style={styles.addToCartBtn} onPress={() => { haptic(); onAdd(product); }}>
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={styles.addToCartText}>Add</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function OrderRow({ order, theme }) {
  const st = STATUS_STYLES[effectiveStatus(order)];
  const date = order.created_at
    ? new Date(order.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
  const itemSummary = (order.order_items || [])
    .map(i => `${i.qty}× ${i.products?.name || "Device"}`)
    .join(", ");
  const tracking = order.fulfillment?.tracking_number;
  return (
    <View style={[styles.orderRow, { borderBottomColor: theme.divider }]}>
      <View style={[styles.orderIconBg, { backgroundColor: st.color + "20" }]}>
        <Ionicons name={st.icon} size={18} color={st.color} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.orderTitle, { color: theme.text }]} numberOfLines={1}>
          {itemSummary || `Order ${order.id.slice(0, 8)}`}
        </Text>
        <Text style={[styles.orderMeta, { color: theme.subtext }]}>{date}</Text>
        {tracking ? (
          <Text style={[styles.orderMeta, { color: theme.subtext }]} numberOfLines={1}>
            Tracking: {tracking}
          </Text>
        ) : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <Text style={[styles.orderTotal, { color: theme.text }]}>{formatMoney(order.total_cents, order.currency)}</Text>
        <View style={[styles.orderStatusBadge, { backgroundColor: st.color + "20" }]}>
          <Text style={[styles.orderStatusText, { color: st.color }]}>{st.label}</Text>
        </View>
      </View>
    </View>
  );
}

export default function OrdersScreen() {
  const { session } = useAuth();
  const { theme } = useTheme();
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [cart, setCart] = useState({}); // { [productId]: quantity }
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(async () => {
    const userId = session?.user?.id;
    if (!userId) return;
    setLoadError(null);
    try {
      const [prods, ords] = await Promise.all([fetchProducts(), fetchOrders(userId)]);
      setProducts(prods);
      setOrders(ords);
    } catch (e) {
      setLoadError(e.message);
    }
    setLoading(false);
  }, [session?.user?.id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const addToCart = (product) =>
    setCart(prev => ({ ...prev, [product.id]: (prev[product.id] || 0) + 1 }));

  const removeFromCart = (product) =>
    setCart(prev => {
      const qty = (prev[product.id] || 0) - 1;
      const next = { ...prev };
      if (qty <= 0) delete next[product.id];
      else next[product.id] = qty;
      return next;
    });

  const cartItems = Object.entries(cart)
    .map(([id, quantity]) => ({ product: products.find(p => p.id === id), quantity }))
    .filter(i => i.product);
  const cartCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const cartTotal = cartItems.reduce((s, i) => s + i.product.price_cents * i.quantity, 0);

  const handleCheckout = async () => {
    if (cartItems.length === 0) return;
    setCheckingOut(true);
    try {
      await startDeviceCheckout(cartItems.map(i => ({ product_id: i.product.id, quantity: i.quantity })));
      // Regardless of how the browser closed, refresh orders — the webhook
      // marks the order paid server-side.
      setCart({});
      await load();
    } catch (e) {
      Alert.alert("Checkout Failed", e.message);
    }
    setCheckingOut(false);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.header}>
        <View>
          <Text style={[styles.greeting, { color: theme.subtext }]}>Shop</Text>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Orders</Text>
        </View>
        {cartCount > 0 && (
          <View style={[styles.cartBadge, { backgroundColor: theme.card, borderColor: theme.border }]}>
            <Ionicons name="cart" size={16} color="#007BFF" />
            <Text style={styles.cartBadgeText}>{cartCount}</Text>
          </View>
        )}
      </View>

      {loading ? (
        <ActivityIndicator color="#007BFF" style={{ marginTop: 60 }} />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#007BFF" />}
        >
          {loadError && (
            <View style={[styles.errorBanner, { backgroundColor: "#fef2f2", borderColor: "#fecaca" }]}>
              <Ionicons name="alert-circle" size={16} color="#ef4444" />
              <Text style={styles.errorBannerText}>{loadError}</Text>
              <TouchableOpacity onPress={load}><Text style={styles.errorRetry}>Retry</Text></TouchableOpacity>
            </View>
          )}

          <Text style={[styles.sectionLabel, { color: theme.subtext }]}>DEVICE CATALOG</Text>
          {products.length === 0 && !loadError ? (
            <View style={[styles.emptyCatalog, { backgroundColor: theme.card }]}>
              <Ionicons name="storefront-outline" size={36} color={theme.subtext} />
              <Text style={[styles.emptyCatalogText, { color: theme.text }]}>Store coming soon</Text>
              <Text style={[styles.emptyCatalogSub, { color: theme.subtext }]}>
                No products are available yet. Check back later.
              </Text>
            </View>
          ) : (
            products.map(p => (
              <ProductCard
                key={p.id}
                product={p}
                quantity={cart[p.id] || 0}
                onAdd={addToCart}
                onRemove={removeFromCart}
                theme={theme}
              />
            ))
          )}

          <Text style={[styles.sectionLabel, { color: theme.subtext, marginTop: 20 }]}>ORDER HISTORY</Text>
          {orders.length === 0 ? (
            <View style={[styles.emptyOrders, { backgroundColor: theme.card }]}>
              <Ionicons name="receipt-outline" size={28} color={theme.subtext} />
              <Text style={[styles.emptyOrdersText, { color: theme.subtext }]}>No orders yet</Text>
            </View>
          ) : (
            <View style={[styles.ordersCard, { backgroundColor: theme.card }]}>
              {orders.map(o => <OrderRow key={o.id} order={o} theme={theme} />)}
            </View>
          )}

          <View style={{ height: cartCount > 0 ? 110 : 20 }} />
        </ScrollView>
      )}

      {cartCount > 0 && (
        <View style={[styles.checkoutBar, { backgroundColor: theme.card, borderTopColor: theme.border }]}>
          <View>
            <Text style={[styles.checkoutCount, { color: theme.subtext }]}>{cartCount} item{cartCount > 1 ? "s" : ""}</Text>
            <Text style={[styles.checkoutTotal, { color: theme.text }]}>{formatMoney(cartTotal)}</Text>
          </View>
          <TouchableOpacity
            style={[styles.checkoutBtn, checkingOut && styles.checkoutBtnDisabled]}
            onPress={() => { haptic(); handleCheckout(); }}
            disabled={checkingOut}
          >
            {checkingOut ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <>
                <Ionicons name="lock-closed" size={15} color="#fff" />
                <Text style={styles.checkoutBtnText}>Checkout with Stripe</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16 },
  greeting: { fontSize: 13, fontWeight: "500" },
  headerTitle: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  cartBadge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1 },
  cartBadgeText: { color: "#007BFF", fontWeight: "800", fontSize: 14 },
  scroll: { paddingHorizontal: 20, paddingBottom: 20 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, marginBottom: 10, marginHorizontal: 2 },
  errorBanner: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1 },
  errorBannerText: { color: "#ef4444", fontSize: 12, fontWeight: "600", flex: 1 },
  errorRetry: { color: "#007BFF", fontSize: 13, fontWeight: "700" },
  productCard: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 16, marginBottom: 12, shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  productIcon: { width: 52, height: 52, borderRadius: 16, justifyContent: "center", alignItems: "center" },
  productName: { fontSize: 15, fontWeight: "700" },
  productDesc: { fontSize: 12, marginTop: 2, lineHeight: 16 },
  productPrice: { fontSize: 15, fontWeight: "800", color: "#007BFF", marginTop: 6 },
  addToCartBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#007BFF", borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9 },
  addToCartText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  qtyControls: { flexDirection: "row", alignItems: "center", gap: 4, borderRadius: 12, padding: 4 },
  qtyBtn: { width: 30, height: 30, borderRadius: 9, justifyContent: "center", alignItems: "center" },
  qtyText: { fontSize: 15, fontWeight: "800", minWidth: 22, textAlign: "center" },
  emptyCatalog: { alignItems: "center", gap: 8, borderRadius: 18, padding: 28 },
  emptyCatalogText: { fontSize: 16, fontWeight: "700" },
  emptyCatalogSub: { fontSize: 13, textAlign: "center" },
  emptyOrders: { alignItems: "center", gap: 8, borderRadius: 18, padding: 24 },
  emptyOrdersText: { fontSize: 13, fontWeight: "600" },
  ordersCard: { borderRadius: 18, overflow: "hidden", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
  orderRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 16, borderBottomWidth: 1 },
  orderIconBg: { width: 38, height: 38, borderRadius: 12, justifyContent: "center", alignItems: "center" },
  orderTitle: { fontSize: 14, fontWeight: "700" },
  orderMeta: { fontSize: 11, marginTop: 2 },
  orderTotal: { fontSize: 14, fontWeight: "800" },
  orderStatusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  orderStatusText: { fontSize: 10, fontWeight: "800" },
  checkoutBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 1 },
  checkoutCount: { fontSize: 11, fontWeight: "600" },
  checkoutTotal: { fontSize: 19, fontWeight: "800" },
  checkoutBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: "#007BFF", borderRadius: 14, paddingHorizontal: 20, paddingVertical: 14 },
  checkoutBtnDisabled: { backgroundColor: "#93c5fd" },
  checkoutBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
