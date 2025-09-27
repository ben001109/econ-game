import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

type Ticket = {
  id: string;
  status: string;
  openedAt: string;
  items: { id: string; qty: number; menuItem: { name: string } }[];
};

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export default function KDS() {
  const router = useRouter();
  const locale = (router.locale || 'en').split('-')[0];
  const messages = locale === 'zh' ? zh : en;
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const r = await fetch(`${API}/kds/tickets`);
    const data = await r.json();
    setTickets(data);
  };

  useEffect(() => {
    load().catch(() => {});
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  const call = async (id: string, action: 'start' | 'serve') => {
    setLoading(true);
    try {
      await fetch(`${API}/kds/tickets/${id}/${action}`, { method: 'POST' });
      await load();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <Head>
        <title>{messages['kds.title']}</title>
      </Head>
      <h1>{messages['kds.title']} (MVP)</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        {tickets.map((ticket) => (
          <div key={ticket.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12 }}>
            <div style={{ fontWeight: 600 }}>#{ticket.id.slice(0, 6)} · {ticket.status}</div>
            <ul style={{ marginTop: 8 }}>
              {ticket.items.map((it) => (
                <li key={it.id}>{it.qty} × {it.menuItem.name}</li>
              ))}
            </ul>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button disabled={loading} onClick={() => call(ticket.id, 'start')}>{messages['kds.start']}</button>
              <button disabled={loading} onClick={() => call(ticket.id, 'serve')}>{messages['kds.serve']}</button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
