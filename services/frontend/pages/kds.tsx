import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

import { productionWebCommandRuntime, WebCommandError } from '../lib/d02-game-command-client';
import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

export default function KDS() {
  const router = useRouter();
  const locale = (router.locale || 'en').split('-')[0];
  const messages = locale === 'zh' ? zh : en;
  const [orderId, setOrderId] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('WEB_COMMAND_MAPPING_NOT_CONFIGURED');

  const run = async (operation: 'kds.start' | 'kds.serve') => {
    setLoading(true);
    try {
      await productionWebCommandRuntime.execute(operation, {
        idempotencyKey: crypto.randomUUID(),
        payload: { orderId },
      });
      setStatus('COMMAND_ACCEPTED');
    } catch (error) {
      setStatus(error instanceof WebCommandError ? error.code : 'WEB_COMMAND_FAILED');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 720 }}>
      <Head>
        <title>{messages['kds.title']}</title>
      </Head>
      <h1>{messages['kds.title']} (D02)</h1>
      <p>
        Ticket reads and mutations do not use the legacy compatibility API. Approved D02 mappings
        and authenticated active-save context are required before these controls can execute.
      </p>
      <input
        aria-label="Order ID"
        value={orderId}
        onChange={(event) => setOrderId(event.target.value)}
        placeholder="Order ID"
      />
      <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
        <button disabled={loading || !orderId} onClick={() => run('kds.start')}>
          {messages['kds.start']}
        </button>
        <button disabled={loading || !orderId} onClick={() => run('kds.serve')}>
          {messages['kds.serve']}
        </button>
      </div>
      <div role="status" style={{ marginTop: 12, color: '#666' }}>
        {status}
      </div>
    </main>
  );
}
