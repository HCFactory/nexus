'use client';

import { useEffect, useState } from 'react';

import {
  deleteStripeConnection,
  listStripeConnections,
  saveStripeConnection,
  setStripeConnectionEnabled,
  testStripeConnection,
} from '@/app/actions/stripe';
// Types come from @/types/stripe, never from the 'use server' module.
import type { StripeConnectionInput, StripeConnectionSummary } from '@/types/stripe';

const INPUT_CLASS =
  'w-full px-3 py-2 border border-border bg-surface text-foreground placeholder:text-foreground-subtle rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent';

function webhookUrl(connectionId: string): string {
  return `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/api/stripe/webhook/${connectionId}`;
}

interface StripeConnectionFormProps {
  connection?: StripeConnectionSummary;
  onSubmit: (values: StripeConnectionInput) => Promise<void>;
  onCancel: () => void;
}

function StripeConnectionForm({ connection, onSubmit, onCancel }: StripeConnectionFormProps) {
  const [displayName, setDisplayName] = useState(connection?.displayName ?? '');
  // Never prefilled: keys are write-only and blank means "unchanged".
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [isDefault, setIsDefault] = useState(connection?.isDefault ?? false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }
    if (!connection && !secretKey.trim()) {
      setError('A secret key is required for a new connection');
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        id: connection?.id,
        displayName: displayName.trim(),
        secretKey: secretKey.trim() || undefined,
        webhookSecret: webhookSecret.trim() || undefined,
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
            {connection ? 'Edit Stripe Connection' : 'New Stripe Connection'}
          </h2>

          {error && (
            <div className="mb-4 p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="stripeDisplayName" className="block text-sm font-medium text-foreground mb-1">
                Display Name
              </label>
              <input
                id="stripeDisplayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={INPUT_CLASS}
                placeholder="e.g., Main Stripe account"
              />
            </div>

            <div>
              <label htmlFor="stripeSecretKey" className="block text-sm font-medium text-foreground mb-1">
                Secret Key
              </label>
              <input
                id="stripeSecretKey"
                type="password"
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                className={INPUT_CLASS}
                placeholder={connection ? 'Leave blank to keep the stored value' : 'sk_test_... or sk_live_...'}
                autoComplete="new-password"
              />
            </div>

            <div>
              <label htmlFor="stripeWebhookSecret" className="block text-sm font-medium text-foreground mb-1">
                Webhook Signing Secret
              </label>
              <input
                id="stripeWebhookSecret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                className={INPUT_CLASS}
                placeholder={connection ? 'Leave blank to keep the stored value' : 'whsec_...'}
                autoComplete="new-password"
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id="stripeIsDefault"
                type="checkbox"
                checked={isDefault}
                onChange={(e) => setIsDefault(e.target.checked)}
                className="rounded border-border"
              />
              <label htmlFor="stripeIsDefault" className="text-sm font-medium text-foreground">
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

export function StripeConnectionsCard() {
  const [connections, setConnections] = useState<StripeConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<StripeConnectionSummary | null>(null);

  function load(isCancelled: () => boolean = () => false): Promise<void> {
    return listStripeConnections()
      .then(
        (list) => {
          if (!isCancelled()) setConnections(list);
        },
        (err: unknown) => {
          console.error('Failed to load Stripe connections:', err);
          if (!isCancelled()) setError('Failed to load connections');
        },
      )
      .finally(() => {
        if (!isCancelled()) setLoading(false);
      });
  }

  const reload = () => load();

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
    // Load once on mount.
  }, []);

  function clearResult(connectionId: string) {
    setResults((prev) => {
      if (!(connectionId in prev)) return prev;
      const next = { ...prev };
      delete next[connectionId];
      return next;
    });
  }

  async function handleCreate(values: StripeConnectionInput) {
    const connectionId = await saveStripeConnection(values);
    clearResult(connectionId);
    await reload();
    setShowCreateForm(false);
  }

  async function handleUpdate(values: StripeConnectionInput) {
    const connectionId = await saveStripeConnection(values);
    clearResult(connectionId);
    await reload();
    setEditingConnection(null);
  }

  async function handleToggle(connection: StripeConnectionSummary) {
    setError('');
    setBusyId(connection.id);
    try {
      await setStripeConnectionEnabled(connection.id, !connection.isEnabled);
      clearResult(connection.id);
      await reload();
    } catch (err) {
      console.error('Failed to update Stripe connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to update connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleTest(connectionId: string) {
    setError('');
    setBusyId(connectionId);
    try {
      const result = await testStripeConnection(connectionId);
      setResults((prev) => ({ ...prev, [connectionId]: result }));
      // A successful test records livemode and the account id.
      if (result.ok) await reload();
    } catch (err) {
      console.error('Failed to test Stripe connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to test connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(connection: StripeConnectionSummary) {
    if (
      !confirm(
        `Delete connection "${connection.displayName}"? The connection and its stored keys will be permanently deleted. This is refused if it has saved cards or payments.`,
      )
    ) {
      return;
    }
    setError('');
    setBusyId(connection.id);
    try {
      await deleteStripeConnection(connection.id);
      clearResult(connection.id);
      await reload();
    } catch (err) {
      console.error('Failed to delete Stripe connection:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete connection');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCopy(connectionId: string) {
    try {
      await navigator.clipboard.writeText(webhookUrl(connectionId));
      setCopiedId(connectionId);
      setTimeout(() => setCopiedId((cur) => (cur === connectionId ? null : cur)), 2000);
    } catch {
      setError('Could not copy to the clipboard');
    }
  }

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm mt-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Stripe Connections</h2>
          <p className="text-sm text-foreground-muted mt-0.5">
            Disabled by default. Nothing contacts Stripe until a connection is enabled.
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
            No Stripe connections configured.
          </div>
        ) : (
          connections.map((connection) => {
            const result = results[connection.id];
            const canTest = connection.isEnabled && connection.hasCredentials;
            const testTitle = !connection.hasCredentials
              ? 'Set a secret key first'
              : !connection.isEnabled
                ? 'Enable the connection first'
                : 'Call Stripe to verify this connection';

            return (
              <div key={connection.id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">{connection.displayName}</span>
                      {connection.livemode !== null && (
                        <span className="text-xs px-2 py-0.5 rounded-full border border-border text-foreground-muted">
                          {connection.livemode ? 'Live' : 'Test'}
                        </span>
                      )}
                      {connection.isDefault && (
                        <span className="text-xs text-foreground-muted">Default</span>
                      )}
                    </div>
                    <p className="text-sm text-foreground-muted mt-0.5">
                      {connection.stripeAccountId ?? 'Not tested yet'}
                      {!connection.hasCredentials && ' · secret key not set'}
                      {!connection.hasWebhookSecret && ' · webhook secret not set'}
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

                <div className="mt-3 flex items-center gap-2 text-sm">
                  <span className="text-foreground-muted">Webhook URL:</span>
                  <code className="text-foreground break-all">{webhookUrl(connection.id)}</code>
                  <button
                    onClick={() => handleCopy(connection.id)}
                    className="px-2 py-1 text-xs border border-border rounded-md"
                  >
                    {copiedId === connection.id ? 'Copied' : 'Copy'}
                  </button>
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
        <StripeConnectionForm onSubmit={handleCreate} onCancel={() => setShowCreateForm(false)} />
      )}
      {editingConnection && (
        <StripeConnectionForm
          connection={editingConnection}
          onSubmit={handleUpdate}
          onCancel={() => setEditingConnection(null)}
        />
      )}
    </div>
  );
}
