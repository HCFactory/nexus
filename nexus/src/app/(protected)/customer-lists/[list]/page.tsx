import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getReferenceListPage, getSelectOptions } from '@/app/actions/customerReferenceLists';
import { ReferenceListClient } from '@/components/customerReferences/ReferenceListClient';
import { LIST_DEFINITIONS } from '@/lib/businessCentral/customerReferences/definitions';
import type { ListKey } from '@/types/customerReferences';

export const dynamic = 'force-dynamic';

export default async function CustomerReferenceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ list: string }>;
  searchParams: Promise<{ jurisdiction?: string | string[] }>;
}) {
  const { list } = await params;
  const { jurisdiction } = await searchParams;
  // taxAreaLines is only reached through a tax area page; noSeries is only a pick list.
  if (!Object.hasOwn(LIST_DEFINITIONS, list) || list === 'taxAreaLines' || list === 'noSeries') notFound();
  const key = list as ListKey;
  const jurisdictionCode = key === 'taxDetails' && typeof jurisdiction === 'string' && jurisdiction ? jurisdiction : undefined;

  let data;
  try {
    data = await getReferenceListPage(key, jurisdictionCode ? { jurisdictionCode } : undefined);
  } catch (e) {
    return (
      <div className="p-5">
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          {e instanceof Error ? e.message : 'Could not load this list'}
        </div>
      </div>
    );
  }

  const sources = [...new Set(data.fields.map((f) => f.optionsFrom).filter((s): s is NonNullable<typeof s> => !!s))];
  const selectOptions: Record<string, { code: string; label: string }[]> = {};
  await Promise.all(
    sources.map(async (source) => {
      selectOptions[source] = await getSelectOptions(source);
    }),
  );

  return (
    <>
      {jurisdictionCode && (
        <p className="px-5 pt-5 text-sm text-foreground-muted">
          Showing rates for jurisdiction {jurisdictionCode} ·{' '}
          <Link className="text-primary hover:underline" href="/customer-lists/taxDetails">
            Show all
          </Link>
        </p>
      )}
      <ReferenceListClient
        data={data}
        selectOptions={selectOptions}
        fixedValues={jurisdictionCode ? { tax_jurisdiction_code: jurisdictionCode } : undefined}
      />
    </>
  );
}
