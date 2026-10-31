'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { getFunctionalRoleLabels, normalizeUserPermissions, resolveUserAccess, summarizeEffectiveAccess } from '@/lib/auth/permissions';
import { Switch } from '@/components/ui';
import { formatHSTShort } from '@/lib/utils';
import { DesignerAccessLevel, PermissionOverrides, User, UserPermissions, UserRole } from '@/types/database';

interface UserListProps {
  users: User[];
  onChangePassword: (userId: string, newPassword: string) => Promise<void>;
  onUpdateUserAccess: (userId: string, input: {
    role: UserRole;
    organizationId: string | null;
    permissions: UserPermissions | null;
  }) => Promise<User>;
}

const OVERRIDE_FIELDS: Array<{
  key: keyof PermissionOverrides;
  label: string;
  description: string;
}> = [
  { key: 'manageUsers', label: 'Manage users', description: 'Open the admin page and edit user access.' },
  { key: 'createOrder', label: 'Create order', description: 'Create new purchase orders.' },
  { key: 'editOrderDate', label: 'Edit order date', description: 'Change purchase order dates.' },
  { key: 'editOrderItems', label: 'Edit order items', description: 'Edit item rows, qty, notes, status, and priority.' },
  { key: 'deleteOrderItems', label: 'Delete order items', description: 'Remove line items from orders.' },
  { key: 'archiveOrders', label: 'Archive orders', description: 'Archive or unarchive orders.' },
  { key: 'deleteOrders', label: 'Delete orders', description: 'Delete entire orders.' },
  { key: 'viewInvoices', label: 'View invoices', description: 'Open the invoice workspace and view linked PO items.' },
  { key: 'createInvoices', label: 'Create invoices', description: 'Create supplier and manufacturer invoice records.' },
  { key: 'editInvoices', label: 'Edit invoices', description: 'Edit invoice header fields.' },
  { key: 'deleteInvoices', label: 'Delete invoices', description: 'Delete draft invoice records.' },
  { key: 'assignInvoices', label: 'Assign invoices', description: 'Assign and unassign PO items to invoice records.' },
  { key: 'viewCustomers', label: 'View customers', description: 'Open the customers list synced from Business Central.' },
  { key: 'editCustomers', label: 'Create and edit customers', description: 'Create, edit and delete customers in Business Central.' },
  { key: 'viewDesignerFields', label: 'View designer fields', description: 'Show version, artwork status, and related UI.' },
  { key: 'editDesignerFields', label: 'Edit designer fields', description: 'Edit version and artwork status.' },
  { key: 'openArtworkModal', label: 'Open artwork modal', description: 'Open the artwork upload/review modal.' },
  { key: 'uploadArtwork', label: 'Upload artwork', description: 'Upload files inside artwork modals.' },
  { key: 'manageUploadStatus', label: 'Manage upload status', description: 'Approve/reject upload sessions.' },
  { key: 'editUploadNotes', label: 'Edit upload notes', description: 'Edit upload session notes.' },
  { key: 'archiveUploadSessions', label: 'Archive uploads', description: 'Archive and unarchive upload sessions.' },
  { key: 'deleteUploadSessions', label: 'Delete uploads', description: 'Delete upload sessions and files.' },
  { key: 'manageCatalog', label: 'Manage catalog', description: 'Create and edit categories, item names, and product lines.' },
  { key: 'createPackagingItems', label: 'Create packaging items', description: 'Create new packaging records directly.' },
  { key: 'editPackagingItems', label: 'Edit packaging items', description: 'Edit packaging records directly.' },
  { key: 'deletePackagingItems', label: 'Delete packaging items', description: 'Delete packaging records.' },
];

function RoleToggleCard({
  title,
  description,
  checked,
  onCheckedChange,
  trailing,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{title}</p>
              <p className="mt-1 text-xs text-foreground-muted">{description}</p>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              {trailing}
              <Switch checked={checked} onCheckedChange={onCheckedChange} aria-label={title} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function clonePermissions(user: User): UserPermissions {
  const normalized = normalizeUserPermissions(user.permissions);
  return {
    functionalRoles: { ...normalized.functionalRoles },
    overrides: { ...normalized.overrides },
  };
}

function RoleSummary({ user }: { user: User }) {
  const labels = getFunctionalRoleLabels(user.permissions);
  const access = resolveUserAccess(user);

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${user.role === 'admin' ? 'bg-purple-500/15 text-purple-300' : 'bg-surface-overlay text-foreground-muted'}`}>
          {user.role === 'admin' ? 'Admin' : 'User'}
        </span>
        {labels.length === 0 ? (
          <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-surface-overlay text-foreground-muted">
            No functional roles
          </span>
        ) : (
          labels.map((label) => (
            <span key={label} className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-primary/15 text-primary">
              {label}
            </span>
          ))
        )}
      </div>
      <p className="text-xs text-foreground-subtle line-clamp-2">
        {summarizeEffectiveAccess(access).slice(0, 4).join(', ') || 'No special access'}
      </p>
    </div>
  );
}

export function UserList({ users, onChangePassword, onUpdateUserAccess }: UserListProps) {
  const [selectedPasswordUser, setSelectedPasswordUser] = useState<User | null>(null);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [permissionsDraft, setPermissionsDraft] = useState<UserPermissions | null>(null);
  const [draftRole, setDraftRole] = useState<UserRole>('user');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loadingPassword, setLoadingPassword] = useState(false);
  const [savingAccess, setSavingAccess] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const effectiveDraftAccess = useMemo(
    () => resolveUserAccess(editingUser ? { ...editingUser, role: draftRole, permissions: permissionsDraft } : null),
    [draftRole, editingUser, permissionsDraft]
  );

  const openAccessEditor = (user: User) => {
    setEditingUser(user);
    setDraftRole(user.role);
    setPermissionsDraft(clonePermissions(user));
    setError('');
    setSuccess('');
  };

  const closeAccessEditor = () => {
    setEditingUser(null);
    setPermissionsDraft(null);
    setDraftRole('user');
    setError('');
  };

  const closePasswordModal = () => {
    setSelectedPasswordUser(null);
    setNewPassword('');
    setConfirmPassword('');
    setError('');
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!selectedPasswordUser) {
      return;
    }

    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoadingPassword(true);
    try {
      await onChangePassword(selectedPasswordUser.id, newPassword);
      setSuccess(`Password updated for ${selectedPasswordUser.display_name}`);
      closePasswordModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change password');
    } finally {
      setLoadingPassword(false);
    }
  };

  const handleAccessSave = async () => {
    if (!editingUser || !permissionsDraft) {
      return;
    }

    setSavingAccess(true);
    setError('');
    setSuccess('');

    try {
      await onUpdateUserAccess(editingUser.id, {
        role: draftRole,
        organizationId: editingUser.organization_id,
        permissions: permissionsDraft,
      });
      setSuccess(`Permissions updated for ${editingUser.display_name}`);
      closeAccessEditor();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update permissions');
    } finally {
      setSavingAccess(false);
    }
  };

  const setDesignerLevel = (designer: DesignerAccessLevel) => {
    setPermissionsDraft((current) => {
      const next = current ?? clonePermissions(editingUser as User);
      return {
        ...next,
        functionalRoles: {
          ...next.functionalRoles,
          designer,
        },
      };
    });
  };

  const setFunctionalRole = (key: 'purchaser' | 'vendor', checked: boolean) => {
    setPermissionsDraft((current) => {
      const next = current ?? clonePermissions(editingUser as User);
      return {
        ...next,
        functionalRoles: {
          ...next.functionalRoles,
          [key]: checked,
        },
      };
    });
  };

  const setOverride = (key: keyof PermissionOverrides, checked: boolean) => {
    setPermissionsDraft((current) => {
      const next = current ?? clonePermissions(editingUser as User);
      return {
        ...next,
        overrides: {
          ...next.overrides,
          [key]: checked,
        },
      };
    });
  };

  const setAdminRole = (checked: boolean) => {
    setDraftRole(checked ? 'admin' : 'user');
  };

  const setDesignerEnabled = (checked: boolean) => {
    setPermissionsDraft((current) => {
      const next = current ?? clonePermissions(editingUser as User);
      return {
        ...next,
        functionalRoles: {
          ...next.functionalRoles,
          designer: checked
            ? next.functionalRoles.designer === 'disabled'
              ? 'view'
              : next.functionalRoles.designer
            : 'disabled',
        },
      };
    });
  };

  return (
    <div>
      {success && (
        <div className="mb-4 p-3 bg-success-subtle border border-success/30 text-success rounded-md text-sm">
          {success}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-destructive-subtle border border-destructive/30 text-destructive rounded-md text-sm">
          {error}
        </div>
      )}

      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        <table className="min-w-full divide-y divide-border">
          <thead className="bg-surface-raised">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-foreground-muted uppercase tracking-wider">User</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-foreground-muted uppercase tracking-wider">Roles & access</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-foreground-muted uppercase tracking-wider">Joined</th>
              <th className="px-6 py-3 text-right text-xs font-medium text-foreground-muted uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="bg-surface divide-y divide-border">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-surface-raised">
                <td className="px-6 py-4 align-top">
                  <div className="flex items-center">
                    <div className="flex-shrink-0 h-10 w-10">
                      <div className="h-10 w-10 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium">
                        {user.display_name.charAt(0).toUpperCase()}
                      </div>
                    </div>
                    <div className="ml-4">
                      <div className="text-sm font-medium text-foreground">{user.display_name}</div>
                      <div className="text-sm text-foreground-muted">{user.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 align-top">
                  <RoleSummary user={user} />
                </td>
                <td className="px-6 py-4 align-top whitespace-nowrap text-sm text-foreground-muted">
                  {formatHSTShort(user.created_at)}
                </td>
                <td className="px-6 py-4 align-top whitespace-nowrap text-right text-sm font-medium">
                  <div className="flex flex-col items-end gap-2">
                    <button onClick={() => openAccessEditor(user)} className="text-primary hover:text-primary-hover">
                      Edit access
                    </button>
                    <button onClick={() => setSelectedPasswordUser(user)} className="text-primary hover:text-primary-hover">
                      Change password
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedPasswordUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-lg shadow-xl max-w-md w-full p-6 border border-border">
            <h3 className="text-lg font-semibold text-foreground mb-4">
              Change Password for {selectedPasswordUser.display_name}
            </h3>

            <form onSubmit={handlePasswordSubmit} className="space-y-4">
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-foreground mb-1">
                  New Password
                </label>
                <input
                  id="newPassword"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-border bg-surface rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-foreground mb-1">
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-border bg-surface rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closePasswordModal}
                  className="flex-1 py-2 px-4 border border-border text-foreground font-medium rounded-md hover:bg-surface-raised transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loadingPassword}
                  className="flex-1 py-2 px-4 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-md transition-colors disabled:opacity-50"
                >
                  {loadingPassword ? 'Updating...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingUser && permissionsDraft && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-surface rounded-lg shadow-xl max-w-4xl w-full border border-border max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-border bg-surface-raised">
              <h3 className="text-lg font-semibold text-foreground">Edit access for {editingUser.display_name}</h3>
              <p className="text-sm text-foreground-muted mt-1">{editingUser.email}</p>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-3">Roles</h4>
                <div className="grid md:grid-cols-2 gap-4">
                  <RoleToggleCard
                    title="Admin"
                    description="Grants full system access, including user management and destructive actions."
                    checked={draftRole === 'admin'}
                    onCheckedChange={setAdminRole}
                  />
                  <RoleToggleCard
                    title="Purchaser"
                    description="Manage purchase order creation, editing, line items, and archive actions."
                    checked={permissionsDraft.functionalRoles.purchaser}
                    onCheckedChange={(checked) => setFunctionalRole('purchaser', checked)}
                  />
                  <RoleToggleCard
                    title="Vendor"
                    description="Open artwork modals and upload artwork without editing protected order fields."
                    checked={permissionsDraft.functionalRoles.vendor}
                    onCheckedChange={(checked) => setFunctionalRole('vendor', checked)}
                  />
                  <RoleToggleCard
                    title="Designer"
                    description="Control designer-specific visibility and edit access for version and artwork status."
                    checked={permissionsDraft.functionalRoles.designer !== 'disabled'}
                    onCheckedChange={setDesignerEnabled}
                    trailing={
                      <select
                        value={permissionsDraft.functionalRoles.designer}
                        onChange={(e) => setDesignerLevel(e.target.value as DesignerAccessLevel)}
                        disabled={permissionsDraft.functionalRoles.designer === 'disabled'}
                        className="w-28 px-3 py-2 border border-border bg-surface rounded-md text-sm disabled:opacity-50"
                        aria-label="Designer access level"
                      >
                        <option value="view">View</option>
                        <option value="edit">Edit</option>
                      </select>
                    }
                  />
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-foreground mb-3">Capability overrides</h4>
                <div className="grid md:grid-cols-2 gap-3">
                  {OVERRIDE_FIELDS.map((field) => {
                    const overrideEnabled = permissionsDraft.overrides[field.key] === true;
                    return (
                      <RoleToggleCard
                        key={field.key}
                        title={field.label}
                        description={field.description}
                        checked={overrideEnabled}
                        onCheckedChange={(checked) => setOverride(field.key, checked)}
                      />
                    );
                  })}
                </div>
              </div>

              <div className="p-4 border border-border rounded-lg bg-surface-raised">
                <h4 className="text-sm font-semibold text-foreground mb-3">Effective access preview</h4>
                <div className="flex flex-wrap gap-2">
                  {summarizeEffectiveAccess(effectiveDraftAccess).map((label) => (
                    <span key={label} className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-primary/15 text-primary">
                      {label}
                    </span>
                  ))}
                  {summarizeEffectiveAccess(effectiveDraftAccess).length === 0 && (
                    <span className="text-sm text-foreground-muted">No special access</span>
                  )}
                </div>
              </div>
            </div>

            <div className="shrink-0 px-6 py-4 border-t border-border bg-surface-raised flex justify-end gap-3">
              <button
                type="button"
                onClick={closeAccessEditor}
                className="py-2 px-4 border border-border text-foreground font-medium rounded-md hover:bg-surface transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAccessSave}
                disabled={savingAccess}
                className="py-2 px-4 bg-primary hover:bg-primary-hover text-primary-foreground font-medium rounded-md transition-colors disabled:opacity-50"
              >
                {savingAccess ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
