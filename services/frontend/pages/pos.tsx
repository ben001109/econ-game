import Head from 'next/head';
import { useRouter } from 'next/router';
import { useState } from 'react';

import {
  productionWebCommandRuntime,
  WebCommandError,
  type D02CommandValue,
} from '../lib/d02-game-command-client';
import en from '../locales/en/common.json';
import zh from '../locales/zh/common.json';

export default function POS() {
  const router = useRouter();
  const locale = (router.locale || 'en').split('-')[0];
  const messages: Record<string, string> = locale === 'zh' ? zh : en;
  const [branchId, setBranchId] = useState('');
  const [tableId, setTableId] = useState('');
  const [orderId, setOrderId] = useState('');
  const [menuItemId, setMenuItemId] = useState('');
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState('WEB_COMMAND_MAPPING_NOT_CONFIGURED');

  const run = async (operation: string, payload: Record<string, D02CommandValue>) => {
    setLoading(true);
    try {
      await productionWebCommandRuntime.execute(operation, {
        idempotencyKey: crypto.randomUUID(),
        payload,
      });
      setLog('COMMAND_ACCEPTED');
    } catch (error) {
      setLog(error instanceof WebCommandError ? error.code : 'WEB_COMMAND_FAILED');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 720 }}>
      <Head>
        <title>{messages['pos.title']}</title>
      </Head>
      <h1>{messages['pos.title']} (D02)</h1>
      <p>
        Operational commands remain fail-closed until the approved Web auth provider, active save,
        version source, and gameplay command mappings are configured.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        <input
          aria-label="Branch ID"
          value={branchId}
          onChange={(event) => setBranchId(event.target.value)}
          placeholder="Branch ID"
        />
        <input
          aria-label="Table ID"
          value={tableId}
          onChange={(event) => setTableId(event.target.value)}
          placeholder="Table ID (optional)"
        />
        <button
          disabled={loading || !branchId}
          onClick={() => run('pos.open', { branchId, ...(tableId ? { tableId } : {}) })}
        >
          {messages['pos.create']}
        </button>
        <input
          aria-label="Order ID"
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          placeholder="Order ID"
        />
        <input
          aria-label="Menu item ID"
          value={menuItemId}
          onChange={(event) => setMenuItemId(event.target.value)}
          placeholder="Menu item ID"
        />
        <button
          disabled={loading || !orderId || !menuItemId}
          onClick={() => run('pos.add-item', { orderId, menuItemId })}
        >
          Add
        </button>
        <button
          disabled={loading || !orderId}
          onClick={() => run('pos.close', { orderId, method: 'cash', close: true })}
        >
          {messages['pos.payClose']}
        </button>
      </div>
      <div role="status" style={{ marginTop: 12, color: '#666' }}>
        {log}
      </div>
    </main>
  );
}
