import { LightOnlyTheme } from '@/components/friendsFamily/LightOnlyTheme';

export default function PublicFriendsFamilyLayout({ children }: { children: React.ReactNode }) {
  return <LightOnlyTheme>{children}</LightOnlyTheme>;
}
