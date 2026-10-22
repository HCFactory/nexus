'use client';

import { useEffect, useState } from 'react';

import {
  deleteBillcomConnection,
  listBillcomConnections,
  saveBillcomConnection,
  setBillcomConnectionEnabled,
  testBillcomConnection,
} from '@/app/actions/billcom';
// Types come from @/types/billcom, never from the 'use server' module.
import type {
  BillcomConnectionInput,
  BillcomConnectionSummary,
  BillcomEnvironment,
} from '@/types/billcom';

const INPUT_CLASS =
  'w-full px-3 py-2 border border-border bg-surface text-foreground placeholder:text-foreground-subtle rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent';

// Mirrors BILLCOM_API_BASE_URLS in app/actions/billcom.ts, which is the
// source of truth and validates this server-side. The URL must follow the
// environment select rather than being free text — otherwise an admin could
// point a connection at an arbitrary host while the badge still reads
// "sandbox" or "production".
const BILLCOM_API_BASE_URLS: Record<BillcomEnvironment, string> = {
  sandbox: 'https://gateway.stage.bill.com/connect',
  production: 'https://gateway.prod.bill.com/connect',
};

interface BillcomConnectionFormProps {
  connection?: BillcomConnectionSummary;
  onSubmit: (values: BillcomConnectionInput) => Promise<void>;
  onCancel: () => void;
}

function BillcomConnectionForm({ connection, onSubmit, onCancel }: BillcomConnectionFormProps) {
  const [displayName, setDisplayName] = useState(connection?.displayName ?? '');
  const [environment, setEnvironment] = useState<BillcomEnvironment>(
    connection?.environment ?? 'sandbox'
  );
  const apiBaseUrl = BILLCOM_API_BASE_URLS[environment];
  const [username, setUsername] = useState(connection?.username ?? '');
  const [billcomOrganizationId, setBillcomOrganizationId] = useState(
    connection?.billcomOrganizationId ?? ''
  );
  const [devKey, setDevKey] = useState('');
  const [password, setPassword] = useState('');
  const [isDefault, setIsDefault] = useState(connection?.isDefault ?? false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!displayName.trim() || !username.trim() || !billcomOrganizationId.trim()) {
      setError('Display name, username, and organization id are required');
      return;
    }
    if (!connection && (!devKey.trim() || !password.trim())) {
      setError('Developer key and password are required for a new connection');
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        id: connection?.id,
        displayName: displayName.trim(),
        environment,
        apiBaseUrl,
        username: username.trim(),
        billcomOrganizationId: billcomOrganizationId.trim(),
        devKey: devKey.trim() || undefined,
        password: password.trim() || undefined,
        isDefault,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <div className="bg-surface-overlay border border-border rounded-lg shadow-xl max-w-md w-full">
        <div className="p-6">
          <h2 className="text-xl font-semibold text-foreground mb-4">
            {connection ? 'Edit Bill.com Connection' : 'New Bill.com Connection'}
          </h2>

          {error && (
            <div className="mb-4 p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="billcomDisplayName" className="block text-sm font-medium text-foreground mb-1">
                Display Name
              </label>
              <input
                id="billcomDisplayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={INPUT_CLASS}
                placeholder="e.g., Production AR"
              />
            </div>

            <div>
              <label htmlFor="billcomEnvironment" className="block text-sm font-medium text-foreground mb-1">
                Environment
              </label>
              <select
                id="billcomEnvironment"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value as BillcomEnvironment)}
                className={INPUT_CLASS}
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </div>

            <div>
              <label htmlFor="billcomApiBaseUrl" className="block text-sm font-medium text-foreground mb-1">
                API Base URL
              </label>
              <input
                id="billcomApiBaseUrl"
                type="text"
                value={apiBaseUrl}
                readOnly
                className={`${INPUT_CLASS} bg-surface-raised text-foreground-muted cursor-not-allowed`}
              />
              <p className="text-xs text-foreground-muted mt-1">
                Set by the selected environment.
              </p>
            </div>

            <div>
              <label htmlFor="billcomUsername" className="block text-sm font-medium text-foreground mb-1">
                Username
              </label>
              <input
                id="billcomUsername"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className={INPUT_CLASS}
              />
            </div>

            <div>
              <label htmlFor="billcomOrgId" className="block text-sm font-medium text-foreground mb-1">
                Bill.com Organization ID
              </label>
              <input
                id="billcomOrgId"
                type="text"
                value={billcomOrganizationId}
                onChange={(e) => setBillcomOrganizationId(e.target.value)}
                className={INPUT_CLASS}
                placeholder="008..."
              />
            </div>

            <div>
              <label htmlFor="billcomDevKey" className="block text-sm font-medium text-foreground mb-1">
                Developer Key
              </label>
              <input
                id="billcomDevKey"
                type="password"
                value={devKey}
                onChange={(e) => setDevKey(e.target.value)}
                className={INPUT_CLASS}
                placeholder={connection ? 'Leave blank to keep the stored value' : ''}
                autoComplete="new-password"
              />
            </div>

            <div>
              <label htmlFor="billcomPassword" className="block text-sm font-medium text-foreground mb-1">
                Password
              </label>
              <input
                id="billcomPassword"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT_CLASS}
                placeholder={connection ? 'Leave blank to keep the stored value' : ''}
                autoComplete="new-password"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id="billcomIsDefault"
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="rounded border-border"
              />
              <label htmlFor="billcomIsDefault" className="text-sm font-medium text-foreground">
                Default connection
              </label>
            </div>

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={onCancel}
                className="flex-1 py-2 px-4 border border-border text-foreground font-medium rounded-md hover:bg-surface-raised transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 py-2 px-4 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-md transition-colors disabled:opacity-50"
              >
                {loading ? 'Saving...' : connection ? 'Save Changes' : 'Create Connection'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

export function BillcomConnectionsCard() {
  const [connections, setConnections] = useState<BillcomConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<BillcomConnectionSummary | null>(null);

  async function reload() {
    try {
      setConnections(await listBillcomConnections());
    } catch (err) {
      console.error('Failed to load Bill.com connections:', err);
      setError('Failed to load connections');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  function clearResult(connectionId: string) {
    setResults((prev) => {
      if (!(connectionId in prev)) return prev;
      const next = { ...prev };
      delete next[connectionId];
      return next;
    });
  }

  async function handleCreate(values: BillcomConnectionInput) {
    const connectionId = await saveBillcomConnection(values);
    clearResult(connectionId);
    await reload();
    setShowCreateForm(false);
  }

  async function handleUpdate(values: BillcomConnectionInput) {
    const connectionId = await saveBillcomConnection(values);
    clearResult(connectionId);
    await reload();
    setEditingConnection(null);
  }

  async function handleToggle(connection: BillcomConnectionSummary) {
    setError('');
    setBusyId(connection.id);
    try {
      await setBillcomConnectionEnabled(connection.id, !connection.isEnabled);
      clearResult(connection.id);
      await reload();
    } catch (err) {
      console.error('Failed to update Bill.com connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to update connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(connectionId: string) {
    setError('');
    setBusyId(connectionId);
    try {
      const result = await testBillcomConnection(connectionId);
      setResults((prev) => ({ ...prev, [connectionId]: result }));
    } catch (err) {
      // testBillcomConnection catches Bill.com login failures internally and
      // returns { ok: false }. A thrown error here means something failed
      // before that — authorization, a missing connection — so it goes
      // through setError rather than the per-row result banner, keeping the
      // two failure modes distinguishable.
      console.error('Failed to test Bill.com connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to test connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(connection: BillcomConnectionSummary) {
    if (
      !confirm(
        `Delete connection "${connection.displayName}"? The stored developer key and password will be permanently deleted.`
      )
    ) {
      return;
    }
    setError('');
    setBusyId(connection.id);
    try {
      await deleteBillcomConnection(connection.id);
      clearResult(connection.id);
      await reload();
    } catch (err) {
      console.error('Failed to delete Bill.com connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm mt-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Bill.com Connections</h2>
          <p className="text-sm text-foreground-muted mt-0.5">
            Disabled by default. Nothing contacts Bill.com until a connection is enabled.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors"
        >
          + New Connection
        </button>
      </div>

      {error && (
        <div className="px-6 pt-4">
          <div className="p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
            {error}
          </div>
        </div>
      )}

      <div className="divide-y divide-border">
        {loading ? (
          <div className="px-6 py-8 text-center text-foreground-muted">Loading...</div>
        ) : connections.length === 0 ? (
          <div className="px-6 py-8 text-center text-foreground-muted">
            No Bill.com connections configured.
          </div>
        ) : (
          connections.map((connection) => {
            const result = results[connection.id];
            const canTest = connection.isEnabled && connection.hasCredentials;
            const testTitle = !connection.hasCredentials
              ? 'Set a developer key and password first'
              : !connection.isEnabled
                ? 'Enable the connection first'
                : 'Log in to Bill.com to verify this connection';

            return (
              <div key={connection.id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{connection.displayName}</span>
                      <span className="text-xs px-2 py-0.5 rounded-full border border-border text-foreground-muted">
                        {connection.environment}
                      </span>
                      {connection.isDefault && (
                        <span className="text-xs text-foreground-muted">Default</span>
                      )}
                    </div>
                    <p className="text-sm text-foreground-muted mt-0.5">
                      {connection.username} · {connection.billcomOrganizationId}
                      {!connection.hasCredentials && ' · credentials not set'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleTest(connection.id)}
                      disabled={!canTest || busyId === connection.id}
                      title={testTitle}
                      className="px-3 py-1.5 text-sm border border-border rounded-md transition-colors disabled:opacity-50"
                    >
                      Test connection
                    </button>
                    <button
                      onClick={() => setEditingConnection(connection)}
                      disabled={busyId === connection.id}
                      className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-md transition-colors disabled:opacity-50"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleToggle(connection)}
                      disabled={busyId === connection.id}
                      className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors disabled:opacity-50"
                    >
                      {connection.isEnabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      onClick={() => handleDelete(connection)}
                      disabled={busyId === connection.id}
                      className="px-3 py-1.5 text-sm text-destructive rounded-md transition-colors disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {result && (
                  <div
                    className={`mt-3 p-3 rounded-md text-sm border ${
                      result.ok
                        ? 'bg-green-500/10 border-green-500/30 text-green-600'
                        : 'bg-destructive-subtle border-destructive/30 text-destructive'
                    }`}
                  >
                    {result.message}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {showCreateForm && (
        <BillcomConnectionForm onSubmit={handleCreate} onCancel={() => setShowCreateForm(false)} />
      )}
      {editingConnection && (
        <BillcomConnectionForm
          connection={editingConnection}
          onSubmit={handleUpdate}
          onCancel={() => setEditingConnection(null)}
        />
      )}
    </div>
  );
}
