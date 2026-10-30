import Link from 'next/link';

import { LIST_DEFINITIONS } from '@/lib/businessCentral/customerReferences/definitions';
import type { ListKey } from '@/types/customerReferences';

export const dynamic = 'force-dynamic';

const MANAGED: ListKey[] = ['paymentTerms', 'customerPriceGroups', 'taxAreas', 'taxJurisdictions', 'taxDetails'];
const COPIED: ListKey[] = ['locations', 'customerPostingGroups', 'generalBusinessPostingGroups'];

function Group({ title, keys }: { title: string; keys: ListKey[] }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground-muted">{title}</h2>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {keys.map((key) => (
          <li key={key}>
            <Link
              href={`/customer-lists/${key}`}
              className="block rounded-xl border border-border bg-surface-raised px-4 py-3 font-medium text-foreground card-shadow hover:bg-surface"
            >
              {LIST_DEFINITIONS[key].title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function CustomerListsPage() {
  return (
    <div className="space-y-6 p-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Customer lists</h1>
        <p className="mt-1 text-xs text-foreground-subtle">Reference lists used when setting up customers.</p>
      </div>
      <Group title="Managed in Nexus" keys={MANAGED} />
      <Group title="Copied from Business Central" keys={COPIED} />
    </div>
  );
}
