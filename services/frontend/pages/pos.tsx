import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useState } from 'react';

import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

type MenuItem = { id: string; name: string; sku: string; basePrice: number };
type Table = { id: string; code: string };
type Branch = { id: string; name: string; tables: Table[] };
type Restaurant = { id: string; name: string; branches: Branch[] };
type Order = { id: string; status: string };

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function POS() {
  const router = useRouter();
  const locale = (router.locale || 'en').split('-')[0];
  const messages: Record<string, string> = locale === 'zh' ? zh : en;
  const [menus, setMenus] = useState<MenuItem[]>([]);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [branchId, setBranchId] = useState('');
  const [tableId, setTableId] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<string>('');

  useEffect(() => {
    fetch(`${API}/menus`).then((r) => r.json()).then(setMenus).catch(() => {});
    fetch(`${API}/restaurants`).then((r) => r.json()).then(setRestaurants).catch(() => {});
  }, []);

  const canCreate = useMemo(() => !!branchId, [branchId]);

  const createOrder = async () => {
    if (!canCreate) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId, tableId: tableId || undefined }),
      });
      const data = await r.json();
      setOrder(data);
      setLog(`Created order ${data.id}`);
    } finally {
      setLoading(false);
    }
  };

  const setupDemo = async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/bootstrap`, { method: 'POST' });
      const data = await r.json();
      const b = data.branches?.[0];
      const t = b?.tables?.[0];
      if (b?.id) setBranchId(b.id);
      if (t?.id) setTableId(t.id);
      setLog('Demo data bootstrapped');
      await fetch(`${API}/menus`).then((x) => x.json()).then(setMenus).catch(() => {});
    } finally {
      setLoading(false);
    }
  };

  const addItem = async (menuItemId: string) => {
    if (!order) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/orders/${order.id}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ menuItemId }),
      });
      const data = await r.json();
      setLog(`Added item ${data.id}`);
    } finally {
      setLoading(false);
    }
  };

  const payAndClose = async () => {
    if (!order) return;
    setLoading(true);
    try {
      const r = await fetch(`${API}/orders/${order.id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'cash', amount: 999, close: true }),
      });
      await r.json();
      setLog(`Paid and closed order`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <Head>
        <title>{messages['pos.title']}</title>
      </Head>
      <h1>{messages['pos.title']} (MVP)</h1>
      <div style={{ display: 'flex', gap: 24 }}>
        <section>
          <h3>Create Order</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label>
              {messages['pos.branch']}:
              <select value={branchId} onChange={(e) => { setBranchId(e.target.value); setTableId(''); }}>
                <option value="">-- select --</option>
                {restaurants.flatMap(r => r.branches).map(b => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>
            <label>
              {messages['pos.table']}:
              <select value={tableId} onChange={(e) => setTableId(e.target.value)} disabled={!branchId}>
                <option value="">-- optional --</option>
                {restaurants.flatMap(r => r.branches).filter(b => b.id === branchId).flatMap(b => b.tables).map(t => (
                  <option key={t.id} value={t.id}>{t.code}</option>
                ))}
              </select>
            </label>
            <button disabled={!canCreate || loading} onClick={createOrder}>{messages['pos.create']}</button>
            <button disabled={loading} onClick={setupDemo}>{messages['pos.setupDemo']}</button>
          </div>
          {order && <div style={{ marginTop: 8 }}>Order: {order.id} ({order.status})</div>}
          <div style={{ marginTop: 8 }}>
            <button disabled={!order || loading} onClick={payAndClose}>{messages['pos.payClose']}</button>
          </div>
          <div style={{ marginTop: 8, color: '#666' }}>{log}</div>
        </section>

        <section>
          <h3>Menu</h3>
          <ul>
            {menus.map((m) => (
              <li key={m.id} style={{ marginBottom: 6 }}>
                {m.name} (${Number(m.basePrice).toFixed(0)}){' '}
                <button disabled={!order || loading} onClick={() => addItem(m.id)}>Add</button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
