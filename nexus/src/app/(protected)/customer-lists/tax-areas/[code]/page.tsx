import { notFound } from 'next/navigation';

import { getReferenceListPage, getSelectOptions } from '@/app/actions/customerReferenceLists';
import { TaxAreaDetailClient } from '@/components/customerReferences/TaxAreaDetailClient';

export const dynamic = 'force-dynamic';

export default async function TaxAreaDetailPage({ params }: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await params;
  let code = rawCode;
  try {
    code = decodeURIComponent(rawCode);
  } catch {
    notFound();
  }

  let areaData, linesData, jurisdictions;
  try {
    [areaData, linesData, jurisdictions] = await Promise.all([
      getReferenceListPage('taxAreas'),
      getReferenceListPage('taxAreaLines', { parentCode: code }),
      getSelectOptions('taxJurisdictions'),
    ]);
  } catch (e) {
    return (
      <div className="p-5">
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive-subtle px-3 py-2 text-sm text-destructive">
          {e instanceof Error ? e.message : 'Could not load this tax area'}
        </div>
      </div>
    );
  }

  const area = areaData.entries.find((e) => e.values.code === code);
  if (!area) notFound();

  return (
    <TaxAreaDetailClient
      area={area}
      areaData={{ ...areaData, entries: [area] }}
      linesData={linesData}
      selectOptions={{ taxJurisdictions: jurisdictions }}
    />
  );
}
