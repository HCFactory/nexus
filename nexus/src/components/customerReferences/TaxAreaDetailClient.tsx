'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Pencil } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { ListPageData, ReferenceEntry } from '@/types/customerReferences';
import { ReferenceEntryForm } from './ReferenceEntryForm';
import { ReferenceListClient } from './ReferenceListClient';

interface Props {
  area: ReferenceEntry;
  areaData: ListPageData;
  linesData: ListPageData;
  selectOptions: Record<string, { code: string; label: string }[]>;
}

export function TaxAreaDetailClient({ area, areaData, linesData, selectOptions }: Props) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const code = String(area.values.code ?? '');

  function areaSaved(warning?: string, saved?: Record<string, unknown>) {
    setEditing(false);
    setNotice(warning ?? null);
    const newCode = saved ? String(saved.code ?? code) : code;
    if (newCode !== code) router.replace(`/customer-lists/tax-areas/${encodeURIComponent(newCode)}`);
    else router.refresh();
  }

  return (
    <div>
      <div className="px-5 pt-5">
        <Link href="/customer-lists/taxAreas" className="text-sm text-primary hover:underline">
          ← Tax areas
        </Link>
      </div>

      <section className="space-y-3 px-5 pt-3">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 flex-1 text-2xl font-semibold tracking-tight text-foreground">Tax area {code}</h1>
          {areaData.canManage && !editing && (
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="size-4" />
              Edit area
            </Button>
          )}
        </header>
        {notice && (
          <div role="status" className="rounded-md border border-border bg-surface px-3 py-2 text-sm text-foreground">
            {notice}
          </div>
        )}
        {editing ? (
          <ReferenceEntryForm
            listKey="taxAreas"
            fields={areaData.fields}
            entry={area}
            selectOptions={selectOptions}
            onDone={areaSaved}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <dl className="grid gap-3 rounded-xl border border-border bg-surface-raised p-4 sm:grid-cols-3">
            {areaData.fields.map((f) => (
              <div key={f.name} className="min-w-0">
                <dt className="text-[11px] uppercase tracking-wide text-foreground-subtle">{f.label}</dt>
                <dd className="text-sm text-foreground">{String(area.values[f.name] ?? '') || '—'}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {linesData.entries.length === 0 && (
        <div role="alert" className="mx-5 mt-4 rounded-md border border-warning/40 bg-warning-subtle px-3 py-2 text-sm text-foreground">
          This tax area has no jurisdictions, so it calculates no tax.
        </div>
      )}

      <ReferenceListClient
        data={{ ...linesData, title: 'Jurisdictions' }}
        selectOptions={selectOptions}
        fixedValues={{ tax_area_code: code }}
        hiddenFields={['tax_area_code']}
        renderRowExtra={(entry) => {
          const j = String(entry.values.tax_jurisdiction_code ?? '');
          return j ? (
            <Link className="text-primary hover:underline" href={`/customer-lists/taxDetails?jurisdiction=${encodeURIComponent(j)}`}>
              Tax rates
            </Link>
          ) : null;
        }}
      />
    </div>
  );
}
