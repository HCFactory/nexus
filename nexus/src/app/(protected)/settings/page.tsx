'use client';

import { useState, useEffect } from 'react';

import { getOrgOrderSettings, upsertOrgOrderSettings } from '@/app/actions/settings';
import { ReceivablesNotificationsCard } from '@/components/settings/ReceivablesNotificationsCard';

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  // Order Number Format is admin-only: the server returns no settings for anyone else.
  const [showOrderSettings, setShowOrderSettings] = useState(false);
  const [orderPrefix, setOrderPrefix] = useState('PO');
  const [orderPadding, setOrderPadding] = useState(5);
  const [orderSettingsSaving, setOrderSettingsSaving] = useState(false);
  const [orderSettingsSaved, setOrderSettingsSaved] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const orderSettings = await getOrgOrderSettings();
        if (orderSettings) {
          setShowOrderSettings(true);
          setOrderPrefix(orderSettings.order_prefix);
          setOrderPadding(orderSettings.order_padding);
        }
      } catch (error) {
        console.error('Failed to load data:', error);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const handleSaveOrderSettings = async () => {
    setOrderSettingsSaving(true);
    setOrderSettingsSaved(false);
    try {
      await upsertOrgOrderSettings({ order_prefix: orderPrefix, order_padding: orderPadding });
      setOrderSettingsSaved(true);
      setTimeout(() => setOrderSettingsSaved(false), 2000);
    } catch (error) {
      console.error('Failed to save order settings:', error);
      alert('Failed to save order settings');
    } finally {
      setOrderSettingsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-foreground-muted">Loading...</div>
      </div>
    );
  }

  return (
    <main className="flex-1 overflow-y-auto p-4 lg:p-6">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-xl lg:text-2xl font-bold text-foreground mb-6">Settings</h1>

          {/* Order Number Format (admins only) */}
          {showOrderSettings && (
          <div className="bg-surface rounded-lg border border-border shadow-sm">
            <div className="px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold text-foreground">Order Number Format</h2>
              <p className="text-sm text-foreground-muted mt-0.5">
                Configures how purchase order numbers are generated (e.g. PO-00001)
              </p>
            </div>
            <div className="px-6 py-5 flex flex-wrap items-end gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Prefix</label>
                <input
                  type="text"
                  value={orderPrefix}
                  onChange={(e) => setOrderPrefix(e.target.value.toUpperCase())}
                  maxLength={10}
                  className="w-24 px-3 py-2 border border-border bg-surface rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                  placeholder="PO"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">Number padding</label>
                <input
                  type="number"
                  value={orderPadding}
                  onChange={(e) => setOrderPadding(Math.max(1, Math.min(10, parseInt(e.target.value) || 1)))}
                  min={1}
                  max={10}
                  className="w-20 px-3 py-2 border border-border bg-surface rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                />
              </div>
              <div>
                <p className="text-sm text-foreground-muted mb-1">Preview</p>
                <p className="text-sm font-mono text-foreground bg-surface-raised border border-border rounded px-3 py-2">
                  {orderPrefix}-{String(1).padStart(orderPadding, '0')}
                </p>
              </div>
              <button
                onClick={handleSaveOrderSettings}
                disabled={orderSettingsSaving}
                className="px-4 py-2 bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-foreground text-sm rounded-md transition-colors"
              >
                {orderSettingsSaving ? 'Saving...' : orderSettingsSaved ? 'Saved!' : 'Save'}
              </button>
            </div>
          </div>
          )}

          <ReceivablesNotificationsCard />
        </div>
    </main>
  );
}
