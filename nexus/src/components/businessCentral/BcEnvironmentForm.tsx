'use client';

import { useState } from 'react';

import { BusinessCentralConnection } from '@/types/database';

export interface BcEnvironmentFormValues {
  displayName: string;
  environment: string;
  apiBaseUrl: string;
  timeZone: string;
  billcomViaConnector: boolean;
  autoSync: boolean;
  billcomConnectionId: string | null;
  stripeConnectionId: string | null;
}

export interface ConnectionOption {
  id: string;
  label: string;
}

interface BcEnvironmentFormProps {
  connection?: BusinessCentralConnection;
  billcomOptions?: ConnectionOption[];
  stripeOptions?: ConnectionOption[];
  onSubmit: (values: BcEnvironmentFormValues) => Promise<void>;
  onCancel: () => void;
}

const INPUT_CLASS =
  'w-full px-3 py-2 border border-border bg-surface text-foreground placeholder:text-foreground-subtle rounded-md focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent';

export function BcEnvironmentForm({ connection, billcomOptions = [], stripeOptions = [], onSubmit, onCancel }: BcEnvironmentFormProps) {
  const [displayName, setDisplayName] = useState(connection?.display_name ?? '');
  const [environment, setEnvironment] = useState(connection?.environment ?? '');
  const [apiBaseUrl, setApiBaseUrl] = useState(connection?.api_base_url ?? '');
  const [timeZone, setTimeZone] = useState(connection?.time_zone ?? '');
  const [billcomViaConnector, setBillcomViaConnector] = useState(connection?.billcom_via_connector ?? false);
  const [autoSync, setAutoSync] = useState(connection?.auto_sync ?? false);
  const [billcomConnectionId, setBillcomConnectionId] = useState(connection?.billcom_connection_id ?? '');
  const [stripeConnectionId, setStripeConnectionId] = useState(connection?.stripe_connection_id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!displayName.trim() || !environment.trim()) {
      setError('Display name and environment are required');
      return;
    }

    setLoading(true);
    try {
      await onSubmit({
        displayName: displayName.trim(),
        environment: environment.trim(),
        apiBaseUrl: apiBaseUrl.trim(),
        timeZone: timeZone.trim(),
        billcomViaConnector,
        autoSync,
        billcomConnectionId: billcomConnectionId || null,
        stripeConnectionId: stripeConnectionId || null,
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
            {connection ? 'Edit Environment' : 'New Environment'}
          </h2>

          {error && (
            <div className="mb-4 p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="bcEnvDisplayName" className="block text-sm font-medium text-foreground mb-1">
                Display Name
              </label>
              <input
                id="bcEnvDisplayName"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className={INPUT_CLASS}
                placeholder="e.g., Production, Test"
              />
            </div>

            <div>
              <label htmlFor="bcEnvEnvironment" className="block text-sm font-medium text-foreground mb-1">
                Environment
              </label>
              <input
                id="bcEnvEnvironment"
                type="text"
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                className={INPUT_CLASS}
                placeholder="e.g., PRODUCTION, SANDBOX"
              />
            </div>

            <div>
              <label htmlFor="bcEnvApiBaseUrl" className="block text-sm font-medium text-foreground mb-1">
                API Base URL <span className="text-foreground-subtle">(optional)</span>
              </label>
              <input
                id="bcEnvApiBaseUrl"
                type="text"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                className={INPUT_CLASS}
                placeholder="https://api.businesscentral.dynamics.com"
              />
            </div>

            <div>
              <label htmlFor="bcEnvTimeZone" className="block text-sm font-medium text-foreground mb-1">
                Time Zone <span className="text-foreground-subtle">(optional)</span>
              </label>
              <input
                id="bcEnvTimeZone"
                type="text"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                className={INPUT_CLASS}
                placeholder="Pacific/Honolulu"
              />
              <p className="mt-1 text-xs text-foreground-subtle">
                IANA time zone for date stamping; leave blank for UTC.
              </p>
            </div>

            <div>
              <label htmlFor="bcEnvBillcom" className="block text-sm font-medium text-foreground mb-1">
                Bill.com connection
              </label>
              <select id="bcEnvBillcom" value={billcomConnectionId} onChange={(e) => setBillcomConnectionId(e.target.value)} className={INPUT_CLASS}>
                <option value="">None</option>
                {billcomOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="bcEnvStripe" className="block text-sm font-medium text-foreground mb-1">
                Stripe connection
              </label>
              <select id="bcEnvStripe" value={stripeConnectionId} onChange={(e) => setStripeConnectionId(e.target.value)} className={INPUT_CLASS}>
                <option value="">None</option>
                {stripeOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-foreground-subtle">
                Bill.com and Stripe work only in environments where a connection is picked.
              </p>
            </div>

            <div>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={billcomViaConnector}
                  onChange={(e) => setBillcomViaConnector(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Bill.com invoices come from Bill.com&apos;s own BC connector</span>
              </label>
              <p className="mt-1 text-xs text-foreground-subtle">
                When ticked, Create invoice and Change invoice post in Business Central only; Bill.com&apos;s connector copies the invoice to Bill.com.
              </p>
            </div>

            <div>
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(e) => setAutoSync(e.target.checked)}
                  className="mt-0.5"
                />
                <span>Sync automatically</span>
              </label>
              <p className="mt-1 text-xs text-foreground-subtle">
                Customers every 15 minutes, everything every 2 hours (needs the schedule set up in Supabase). Usually only Production.
              </p>
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
                {loading ? 'Saving...' : connection ? 'Save Changes' : 'Create Environment'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
