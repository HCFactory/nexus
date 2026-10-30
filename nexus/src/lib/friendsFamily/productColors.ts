import type { FriendsFamilyProductColor } from '@/types/database';

export const FRIENDS_FAMILY_PRODUCT_COLORS: Array<{
  value: FriendsFamilyProductColor;
  label: string;
  background: string;
  foreground: string;
  border: string;
}> = [
  { value: 'slate', label: 'Slate', background: '#f1f5f9', foreground: '#334155', border: '#cbd5e1' },
  { value: 'red', label: 'Red', background: '#fee2e2', foreground: '#991b1b', border: '#fecaca' },
  { value: 'orange', label: 'Orange', background: '#ffedd5', foreground: '#9a3412', border: '#fed7aa' },
  { value: 'yellow', label: 'Yellow', background: '#fef9c3', foreground: '#854d0e', border: '#fde68a' },
  { value: 'green', label: 'Green', background: '#dcfce7', foreground: '#166534', border: '#bbf7d0' },
  { value: 'blue', label: 'Blue', background: '#dbeafe', foreground: '#1e40af', border: '#bfdbfe' },
  { value: 'purple', label: 'Purple', background: '#f3e8ff', foreground: '#6b21a8', border: '#e9d5ff' },
  { value: 'pink', label: 'Pink', background: '#fce7f3', foreground: '#9d174d', border: '#fbcfe8' },
];

export function getFriendsFamilyProductColor(value: FriendsFamilyProductColor) {
  return FRIENDS_FAMILY_PRODUCT_COLORS.find((color) => color.value === value)
    ?? FRIENDS_FAMILY_PRODUCT_COLORS[0];
}
