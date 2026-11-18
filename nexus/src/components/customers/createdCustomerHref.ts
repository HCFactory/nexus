/** Query parameter the customer profile reads to show a note after a create. */
export const NOTE_PARAM = 'note';

/** Where to go after creating a customer: its profile, with any notes to show there. */
export function createdCustomerHref(id: string, notes: (string | null | undefined)[]): string {
  const text = notes.filter((n): n is string => Boolean(n?.trim())).join(' ');
  const path = `/customers/${encodeURIComponent(id)}`;
  return text ? `${path}?${new URLSearchParams({ [NOTE_PARAM]: text })}` : path;
}
