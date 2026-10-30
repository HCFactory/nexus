import { notFound } from 'next/navigation';

import { getReferenceListPage, getSelectOptions } from '@/app/actions/customerReferenceLists';
import { ReferenceListClient } from '@/components/customerReferences/ReferenceListClient';
import { LIST_DEFINITIONS } from '@/lib/businessCentral/customerReferences/definitions';
import type { ListKey } from '@/types/customerReferences';

export const dynamic = 'force-dynamic';

export default async function CustomerReferenceListPage({ params }: { params: Promise<{ list: string }> }) {
  const { list } = await params;
  // taxAreaLines is only reached through a tax area page.
  if (!Object.hasOwn(LIST_DEFINITIONS, list) || list === 'taxAreaLines') notFound();
  const key = list as ListKey;

  let data;
  try {
    data = await getReferenceListPage(key);
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

  return <ReferenceListClient data={data} selectOptions={selectOptions} />;
}
