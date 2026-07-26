import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Icon from "../components/Icon";
import { useAuth } from "../context/AuthContext";
import {
  ORDER_STATUS, effectiveStatus, fetchOrders, fetchProducts,
  formatMoney, startDeviceCheckout,
} from "../lib/billing";

export default function Orders() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [cart, setCart] = useState({}); // { [productId]: quantity }
  const [loading, setLoading] = useState(true);
  const [checkingOut, setCheckingOut] = useState(false);
  const [error, setError] = useState(null);

  // Stripe redirects back here with ?status=success|cancel
  const [params, setParams] = useSearchParams();
  const returnStatus = params.get("status");

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const [prods, ords] = await Promise.all([fetchProducts(), fetchOrders(userId)]);
      setProducts(prods);
      setOrders(ords);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  // Coming back from a successful checkout, the cart is spent — the webhook
  // marks the order paid server-side, so just clear and refetch.
  useEffect(() => {
    if (returnStatus === "success") setCart({});
  }, [returnStatus]);

  const dismissStatus = () => {
    params.delete("status");
    setParams(params, { replace: true });
  };

  const addToCart = (p) => setCart((c) => ({ ...c, [p.id]: (c[p.id] || 0) + 1 }));
  const removeFromCart = (p) =>
    setCart((c) => {
      const qty = (c[p.id] || 0) - 1;
      const next = { ...c };
      if (qty <= 0) delete next[p.id];
      else next[p.id] = qty;
      return next;
    });

  const cartItems = Object.entries(cart)
    .map(([id, quantity]) => ({ product: products.find((p) => p.id === id), quantity }))
    .filter((i) => i.product);
  const cartCount = cartItems.reduce((s, i) => s + i.quantity, 0);
  const cartTotal = cartItems.reduce((s, i) => s + i.product.price_cents * i.quantity, 0);

  const checkout = async () => {
    if (!cartItems.length) return;
    setCheckingOut(true);
    setError(null);
    try {
      // Redirects the browser to Stripe — nothing after this runs on success.
      await startDeviceCheckout(
        cartItems.map((i) => ({ product_id: i.product.id, quantity: i.quantity }))
      );
    } catch (e) {
      setError(e.message);
      setCheckingOut(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-titles">
          <div className="topbar-eyebrow">Shop</div>
          <h1 className="topbar-title">Orders</h1>
        </div>
        <div className="topbar-actions">
          {cartCount > 0 && (
            <span className="badge" style={{ background: "var(--inputBg)", color: "var(--accent)" }}>
              <Icon name="cart" size={13} /> {cartCount}
            </span>
          )}
          <button className="btn btn-icon" onClick={load} title="Refresh">
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </header>

      <div className="page" style={{ maxWidth: 1120 }}>
        {returnStatus === "success" && (
          <div className="banner" style={{ background: "#22c55e1a", borderColor: "#22c55e55", color: "#16a34a", marginBottom: 18 }}>
            <Icon name="success" size={17} />
            <span className="grow">
              Payment complete. Your order appears below once Stripe confirms it — refresh in a moment if it's not there yet.
            </span>
            <button className="btn btn-sm" onClick={dismissStatus}>Dismiss</button>
          </div>
        )}
        {returnStatus === "cancel" && (
          <div className="banner" style={{ background: "#f59e0b1a", borderColor: "#f59e0b55", color: "#f59e0b", marginBottom: 18 }}>
            <Icon name="info" size={17} />
            <span className="grow">Checkout canceled — your cart is still here.</span>
            <button className="btn btn-sm" onClick={dismissStatus}>Dismiss</button>
          </div>
        )}

        {error && (
          <div className="banner" style={{ background: "#ef44441a", borderColor: "#ef444455", color: "#ef4444", marginBottom: 18 }}>
            <Icon name="alert" size={17} />
            <span className="grow">{error}</span>
            <button className="btn btn-sm" onClick={load}>Retry</button>
          </div>
        )}

        <div className="orders-split">
          {/* ── Catalog ──────────────────────────────────────────────────── */}
          <div>
            <div className="section-head" style={{ marginTop: 0 }}>
              <div>
                <h2 className="section-title">Device Catalog</h2>
                <p className="section-sub">Sensors and filter tags, shipped to you.</p>
              </div>
            </div>

            {loading ? (
              <div className="col gap-sm">
                {[0, 1, 2].map((i) => <div key={i} className="skel" style={{ height: 96, borderRadius: 16 }} />)}
              </div>
            ) : products.length === 0 ? (
              <div className="card empty">
                <div className="empty-icon"><Icon name="store" size={24} /></div>
                <h3 style={{ fontSize: 17, fontWeight: 800, color: "var(--text)" }}>Store coming soon</h3>
                <p className="hint">No products are available yet. Check back later.</p>
              </div>
            ) : (
              <div className="col" style={{ gap: 12 }}>
                {products.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    quantity={cart[p.id] || 0}
                    onAdd={() => addToCart(p)}
                    onRemove={() => removeFromCart(p)}
                  />
                ))}
              </div>
            )}

            <div className="section-head">
              <div>
                <h2 className="section-title">Order History</h2>
                <p className="section-sub">Payment and shipment status for past orders.</p>
              </div>
            </div>

            {loading ? (
              <div className="skel" style={{ height: 140, borderRadius: 16 }} />
            ) : orders.length === 0 ? (
              <div className="card empty">
                <div className="empty-icon"><Icon name="receipt" size={24} /></div>
                <p className="hint">No orders yet.</p>
              </div>
            ) : (
              <div className="card">
                {orders.map((o) => <OrderRow key={o.id} order={o} />)}
              </div>
            )}
          </div>

          {/* ── Cart ─────────────────────────────────────────────────────── */}
          <aside className="cart-panel">
            <div className="card card-pad">
              <div className="row" style={{ marginBottom: 14 }}>
                <div className="property-icon"><Icon name="cart" size={17} /></div>
                <div className="grow">
                  <h3 className="section-title" style={{ fontSize: 15.5 }}>Your Cart</h3>
                  <p className="section-sub">{cartCount} item{cartCount === 1 ? "" : "s"}</p>
                </div>
              </div>

              {cartItems.length === 0 ? (
                <p className="hint" style={{ padding: "16px 0", textAlign: "center" }}>
                  Cart is empty. Add a device to get started.
                </p>
              ) : (
                <>
                  <div className="col gap-sm" style={{ marginBottom: 14 }}>
                    {cartItems.map(({ product, quantity }) => (
                      <div className="row" key={product.id} style={{ fontSize: 13 }}>
                        <span className="grow truncate">
                          <strong>{quantity}×</strong> {product.name}
                        </span>
                        <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                          {formatMoney(product.price_cents * quantity, product.currency)}
                        </span>
                      </div>
                    ))}
                  </div>

                  <div
                    className="row"
                    style={{ borderTop: "1px solid var(--divider)", paddingTop: 13, marginBottom: 14 }}
                  >
                    <span className="grow" style={{ fontWeight: 700 }}>Total</span>
                    <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
                      {formatMoney(cartTotal)}
                    </span>
                  </div>

                  <button className="btn btn-primary btn-block" onClick={checkout} disabled={checkingOut}>
                    {checkingOut ? <span className="spinner" /> : <><Icon name="lock" size={15} /> Checkout with Stripe</>}
                  </button>
                  <p className="hint" style={{ marginTop: 9, fontSize: 11.5, textAlign: "center" }}>
                    You'll be redirected to Stripe. Card details never touch this app.
                  </p>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function ProductRow({ product, quantity, onAdd, onRemove }) {
  return (
    <article className="card row" style={{ padding: 16, gap: 14, alignItems: "flex-start" }}>
      <div className="list-icon" style={{ width: 48, height: 48, borderRadius: 14, color: "var(--accent)" }}>
        <Icon name="device" size={22} />
      </div>
      <div className="grow">
        <div style={{ fontSize: 14.5, fontWeight: 700 }}>{product.name}</div>
        {product.description && (
          <p className="hint" style={{ marginTop: 3, maxWidth: 460 }}>{product.description}</p>
        )}
        <div style={{ fontSize: 15, fontWeight: 800, color: "var(--accent)", marginTop: 7 }}>
          {formatMoney(product.price_cents, product.currency)}
        </div>
      </div>

      {quantity > 0 ? (
        <div className="row gap-sm" style={{ background: "var(--inputBg)", borderRadius: 11, padding: 4 }}>
          <button className="btn btn-icon btn-sm" onClick={onRemove} aria-label="Remove one">
            <Icon name="minus" size={14} />
          </button>
          <span style={{ minWidth: 20, textAlign: "center", fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
            {quantity}
          </span>
          <button className="btn btn-icon btn-sm" onClick={onAdd} aria-label="Add one">
            <Icon name="plus" size={14} />
          </button>
        </div>
      ) : (
        <button className="btn btn-primary btn-sm" onClick={onAdd}>
          <Icon name="plus" size={14} /> Add
        </button>
      )}
    </article>
  );
}

function OrderRow({ order }) {
  const st = ORDER_STATUS[effectiveStatus(order)];
  const date = order.created_at
    ? new Date(order.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "";
  const summary = (order.order_items || [])
    .map((i) => `${i.qty}× ${i.products?.name || "Device"}`)
    .join(", ");
  const tracking = order.fulfillment?.tracking_number;
  const trackingUrl = order.fulfillment?.tracking_url;

  return (
    <div className="list-row">
      <div className="list-icon" style={{ background: `${st.color}1f`, color: st.color }}>
        <Icon name={st.icon} size={17} />
      </div>
      <div className="grow">
        <div style={{ fontSize: 13.5, fontWeight: 700 }} className="truncate">
          {summary || `Order ${order.id.slice(0, 8)}`}
        </div>
        <div className="hint" style={{ fontSize: 11.5 }}>{date}</div>
        {tracking && (
          <div className="hint" style={{ fontSize: 11.5 }}>
            Tracking: {trackingUrl
              ? <a href={trackingUrl} target="_blank" rel="noreferrer" className="link-btn">{tracking} <Icon name="external" size={10} /></a>
              : <span className="mono">{tracking}</span>}
          </div>
        )}
      </div>
      <div className="col" style={{ alignItems: "flex-end", gap: 5 }}>
        <span style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>
          {formatMoney(order.total_cents, order.currency)}
        </span>
        <span className="badge" style={{ background: `${st.color}1f`, color: st.color }}>{st.label}</span>
      </div>
    </div>
  );
}
