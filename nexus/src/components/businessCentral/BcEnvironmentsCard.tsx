'use client';

import { useEffect, useState } from 'react';

import {
  createBcConnection,
  deleteBcConnection,
  listBcConnections,
  setDefaultBcConnection,
  updateBcConnection,
  verifyBcConnection,
} from '@/app/actions/businessCentralConnections';
import { BusinessCentralConnection } from '@/types/database';

import { listBillcomConnections } from '@/app/actions/billcom';
import { listStripeConnections } from '@/app/actions/stripe';
import { BcEnvironmentForm, BcEnvironmentFormValues, type ConnectionOption } from './BcEnvironmentForm';

const RECENT_VERIFY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type StatusTone = 'verified' | 'error' | 'unverified';

function connectionStatus(connection: BusinessCentralConnection): {
  tone: StatusTone;
  dotClass: string;
  label: string;
} {
  if (connection.last_error) {
    return { tone: 'error', dotClass: 'bg-destructive', label: connection.last_error };
  }
  if (
    connection.last_verified_at &&
    Date.now() - Date.parse(connection.last_verified_at) < RECENT_VERIFY_WINDOW_MS
  ) {
    return { tone: 'verified', dotClass: 'bg-green-500', label: 'Verified' };
  }
  return { tone: 'unverified', dotClass: 'bg-foreground-subtle', label: 'Not verified yet' };
}

export function BcEnvironmentsCard() {
  const [connections, setConnections] = useState<BusinessCentralConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingConnection, setEditingConnection] = useState<BusinessCentralConnection | null>(null);
  const [billcomOptions, setBillcomOptions] = useState<ConnectionOption[]>([]);
  const [stripeOptions, setStripeOptions] = useState<ConnectionOption[]>([]);

  // The Bill.com and Stripe connections an environment can pick (admin-only lists).
  useEffect(() => {
    let active = true;
    Promise.all([listBillcomConnections().catch(() => []), listStripeConnections().catch(() => [])]).then(([bill, stripe]) => {
      if (!active) return;
      setBillcomOptions(bill.map((c) => ({ id: c.id, label: `${c.displayName} (${c.environment})` })));
      setStripeOptions(stripe.map((c) => ({ id: c.id, label: `${c.displayName} (${c.livemode ? 'live' : 'test'})` })));
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    listBcConnections()
      .then((data) => {
        if (active) setConnections(data);
      })
      .catch((err) => {
        if (active) {
          console.error('Failed to load Business Central environments:', err);
          setError('Failed to load environments');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const reload = async () => {
    const data = await listBcConnections();
    setConnections(data);
  };

  const handleCreate = async (values: BcEnvironmentFormValues) => {
    await createBcConnection({
      displayName: values.displayName,
      environment: values.environment,
      apiBaseUrl: values.apiBaseUrl || null,
      timeZone: values.timeZone || null,
    });
    await reload();
    setShowCreateForm(false);
  };

  const handleUpdate = async (values: BcEnvironmentFormValues) => {
    if (!editingConnection) return;
    await updateBcConnection(editingConnection.id, {
      displayName: values.displayName,
      environment: values.environment,
      apiBaseUrl: values.apiBaseUrl || null,
      timeZone: values.timeZone || null,
      billcomViaConnector: values.billcomViaConnector,
      billcomConnectionId: values.billcomConnectionId,
      stripeConnectionId: values.stripeConnectionId,
    });
    await reload();
    setEditingConnection(null);
  };

  const handleSetDefault = async (id: string) => {
    setError('');
    setBusyId(id);
    try {
      await setDefaultBcConnection(id);
      await reload();
    } catch (err) {
      console.error('Failed to set default environment:', err);
      setError(err instanceof Error ? err.message : 'Failed to set default environment');
    } finally {
      setBusyId(null);
    }
  };

  const handleVerify = async (id: string) => {
    setError('');
    setBusyId(id);
    try {
      await verifyBcConnection(id);
    } catch (err) {
      console.error('Failed to verify environment:', err);
      setError(err instanceof Error ? err.message : 'Failed to verify environment');
    } finally {
      // Reload regardless — verifyBcConnection records last_error on failure.
      await reload().catch(() => undefined);
      setBusyId(null);
    }
  };

  const handleDelete = async (connection: BusinessCentralConnection) => {
    if (
      !confirm(
        `Delete environment "${connection.display_name}"? Items synced from this environment will become orphaned but are not deleted.`
      )
    ) {
      return;
    }
    setError('');
    setBusyId(connection.id);
    try {
      await deleteBcConnection(connection.id);
      await reload();
    } catch (err) {
      console.error('Failed to delete environment:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete environment');
    } finally {
      setBusyId(null);
    }
  };

  const onlyOne = connections.length <= 1;

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm mt-6">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Business Central Environments</h2>
          <p className="text-sm text-foreground-muted mt-0.5">
            Each environment connects to a Business Central company.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-3 py-1.5 text-sm bg-primary hover:bg-primary-hover text-primary-foreground rounded-md transition-colors"
        >
          + New Environment
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
            <p>No environments yet</p>
            <button
              onClick={() => setShowCreateForm(true)}
              className="mt-2 text-sm text-primary hover:text-primary-hover"
            >
              Create your first environment
            </button>
          </div>
        ) : (
          connections.map((connection) => {
            const status = connectionStatus(connection);
            const busy = busyId === connection.id;
            return (
              <div key={connection.id} className="px-6 py-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${status.dotClass}`}
                    title={status.label}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">
                        {connection.display_name}
                      </p>
                      {connection.is_default && (
                        <span className="inline-block px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary rounded">
                          Default
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-foreground-muted truncate">
                      {connection.environment}
                      {connection.company_name ? ` · ${connection.company_name}` : ''}
                    </p>
                    {connection.last_error && (
                      <p className="text-xs text-destructive truncate mt-0.5">{connection.last_error}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {!connection.is_default && (
                    <button
                      onClick={() => handleSetDefault(connection.id)}
                      disabled={busy}
                      className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-md transition-colors disabled:opacity-50"
                    >
                      Set default
                    </button>
                  )}
                  <button
                    onClick={() => handleVerify(connection.id)}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-md transition-colors disabled:opacity-50"
                  >
                    {busy ? 'Working...' : 'Verify'}
                  </button>
                  <button
                    onClick={() => setEditingConnection(connection)}
                    disabled={busy}
                    className="px-3 py-1.5 text-sm text-foreground-muted hover:text-foreground hover:bg-surface-raised rounded-md transition-colors disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(connection)}
                    disabled={busy || onlyOne}
                    title={onlyOne ? 'Cannot delete the only environment' : undefined}
                    className="px-3 py-1.5 text-sm text-destructive hover:bg-destructive-subtle rounded-md transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showCreateForm && (
        <BcEnvironmentForm onSubmit={handleCreate} onCancel={() => setShowCreateForm(false)} />
      )}
      {editingConnection && (
        <BcEnvironmentForm
          connection={editingConnection}
          billcomOptions={billcomOptions}
          stripeOptions={stripeOptions}
          onSubmit={handleUpdate}
          onCancel={() => setEditingConnection(null)}
        />
      )}
    </div>
  );
}
