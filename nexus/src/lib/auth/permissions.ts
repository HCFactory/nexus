import {
  DesignerAccessLevel,
  FunctionalRoles,
  PermissionOverrides,
  User,
  UserPermissions,
} from '@/types/database';

export interface ResolvedUserAccess {
  isAdmin: boolean;
  canAccessAdminPage: boolean;
  canManageUsers: boolean;
  canCreateOrder: boolean;
  canAddOrderItems: boolean;
  canEditOrderDate: boolean;
  canEditOrderItems: boolean;
  canEditOrderItemDetails: boolean;
  canDeleteOrderItems: boolean;
  canArchiveOrders: boolean;
  canDeleteOrders: boolean;
  canViewInvoices: boolean;
  canCreateInvoices: boolean;
  canEditInvoices: boolean;
  canDeleteInvoices: boolean;
  canAssignInvoices: boolean;
  canViewCustomers: boolean;
  canEditCustomers: boolean;
  canViewReceivables: boolean;
  canViewDesignerFields: boolean;
  canViewArtworkFields: boolean;
  canEditDesignerFields: boolean;
  canEditArtworkFields: boolean;
  canOpenArtworkModal: boolean;
  canViewArtworkWorkspace: boolean;
  canUploadArtwork: boolean;
  canUploadArtworkFiles: boolean;
  canManageUploadStatus: boolean;
  canEditUploadStatus: boolean;
  canEditUploadNotes: boolean;
  canArchiveUploadSessions: boolean;
  canDeleteUploadSessions: boolean;
  canManageCatalog: boolean;
  canManageCategories: boolean;
  canManageItemNames: boolean;
  canManageProductLines: boolean;
  canCreatePackagingItems: boolean;
  canEditPackagingItems: boolean;
  canDeletePackagingItems: boolean;
}

export type UserAccess = ResolvedUserAccess;

export const DEFAULT_FUNCTIONAL_ROLES: FunctionalRoles = {
  purchaser: false,
  vendor: false,
  designer: 'disabled',
};

export const DEFAULT_PERMISSIONS: UserPermissions = {
  functionalRoles: DEFAULT_FUNCTIONAL_ROLES,
  overrides: {},
};

const ACCESS_KEYS = [
  'canAccessAdminPage',
  'canManageUsers',
  'canCreateOrder',
  'canAddOrderItems',
  'canEditOrderDate',
  'canEditOrderItems',
  'canEditOrderItemDetails',
  'canDeleteOrderItems',
  'canArchiveOrders',
  'canDeleteOrders',
  'canViewInvoices',
  'canCreateInvoices',
  'canEditInvoices',
  'canDeleteInvoices',
  'canAssignInvoices',
  'canViewCustomers',
  'canEditCustomers',
  'canViewReceivables',
  'canViewDesignerFields',
  'canViewArtworkFields',
  'canEditDesignerFields',
  'canEditArtworkFields',
  'canOpenArtworkModal',
  'canViewArtworkWorkspace',
  'canUploadArtwork',
  'canUploadArtworkFiles',
  'canManageUploadStatus',
  'canEditUploadStatus',
  'canEditUploadNotes',
  'canArchiveUploadSessions',
  'canDeleteUploadSessions',
  'canManageCatalog',
  'canManageCategories',
  'canManageItemNames',
  'canManageProductLines',
  'canCreatePackagingItems',
  'canEditPackagingItems',
  'canDeletePackagingItems',
] as const satisfies ReadonlyArray<keyof ResolvedUserAccess>;

const OVERRIDE_TO_ACCESS_KEY: Record<keyof PermissionOverrides, keyof ResolvedUserAccess> = {
  accessAdminPage: 'canAccessAdminPage',
  manageUsers: 'canManageUsers',
  createOrder: 'canCreateOrder',
  editOrderDate: 'canEditOrderDate',
  editOrderItems: 'canEditOrderItems',
  deleteOrderItems: 'canDeleteOrderItems',
  archiveOrders: 'canArchiveOrders',
  deleteOrders: 'canDeleteOrders',
  viewInvoices: 'canViewInvoices',
  createInvoices: 'canCreateInvoices',
  editInvoices: 'canEditInvoices',
  deleteInvoices: 'canDeleteInvoices',
  assignInvoices: 'canAssignInvoices',
  viewCustomers: 'canViewCustomers',
  editCustomers: 'canEditCustomers',
  viewReceivables: 'canViewReceivables',
  viewDesignerFields: 'canViewDesignerFields',
  editDesignerFields: 'canEditDesignerFields',
  openArtworkModal: 'canOpenArtworkModal',
  uploadArtwork: 'canUploadArtwork',
  manageUploadStatus: 'canManageUploadStatus',
  editUploadNotes: 'canEditUploadNotes',
  archiveUploadSessions: 'canArchiveUploadSessions',
  deleteUploadSessions: 'canDeleteUploadSessions',
  manageCatalog: 'canManageCatalog',
  createPackagingItems: 'canCreatePackagingItems',
  editPackagingItems: 'canEditPackagingItems',
  deletePackagingItems: 'canDeletePackagingItems',
};

function isDesignerLevel(value: unknown): value is DesignerAccessLevel {
  return value === 'disabled' || value === 'view' || value === 'edit';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function normalizeUserPermissions(input: unknown): UserPermissions {
  if (!isObject(input)) {
    return {
      functionalRoles: { ...DEFAULT_FUNCTIONAL_ROLES },
      overrides: {},
    };
  }

  const functionalRolesInput = isObject(input.functionalRoles) ? input.functionalRoles : {};
  const overridesInput = isObject(input.overrides) ? input.overrides : {};

  const functionalRoles: FunctionalRoles = {
    purchaser: functionalRolesInput.purchaser === true,
    vendor: functionalRolesInput.vendor === true,
    designer: isDesignerLevel(functionalRolesInput.designer)
      ? functionalRolesInput.designer
      : DEFAULT_FUNCTIONAL_ROLES.designer,
  };

  const overrides: PermissionOverrides = {};
  for (const overrideKey of Object.keys(OVERRIDE_TO_ACCESS_KEY) as Array<keyof PermissionOverrides>) {
    const value = overridesInput[overrideKey];
    if (typeof value === 'boolean') {
      overrides[overrideKey] = value;
    }
  }

  return {
    functionalRoles,
    overrides,
  };
}

export function getFunctionalRoleLabels(permissions: UserPermissions | null | undefined): string[] {
  const normalized = normalizeUserPermissions(permissions);
  const labels: string[] = [];

  if (normalized.functionalRoles.purchaser) {
    labels.push('Purchaser');
  }

  if (normalized.functionalRoles.vendor) {
    labels.push('Vendor');
  }

  if (normalized.functionalRoles.designer !== 'disabled') {
    labels.push(
      normalized.functionalRoles.designer === 'edit' ? 'Designer (edit)' : 'Designer (view)'
    );
  }

  return labels;
}

export function resolveUserAccess(user: Pick<User, 'role' | 'permissions'> | null | undefined): ResolvedUserAccess {
  const isAdmin = user?.role === 'admin';
  const permissions = normalizeUserPermissions(user?.permissions);
  const { purchaser, vendor, designer } = permissions.functionalRoles;

  const access: ResolvedUserAccess = {
    isAdmin,
    canAccessAdminPage: isAdmin,
    canManageUsers: isAdmin,
    canCreateOrder: isAdmin || purchaser,
    canAddOrderItems: isAdmin || purchaser,
    canEditOrderDate: isAdmin || purchaser,
    canEditOrderItems: isAdmin || purchaser,
    canEditOrderItemDetails: isAdmin || purchaser,
    canDeleteOrderItems: isAdmin || purchaser,
    canArchiveOrders: isAdmin || purchaser,
    canDeleteOrders: isAdmin,
    canViewInvoices: isAdmin || purchaser,
    canCreateInvoices: isAdmin || purchaser,
    canEditInvoices: isAdmin || purchaser,
    canDeleteInvoices: isAdmin || purchaser,
    canAssignInvoices: isAdmin || purchaser,
    canViewCustomers: isAdmin,
    canEditCustomers: isAdmin,
    canViewReceivables: isAdmin,
    canViewDesignerFields: isAdmin || vendor || designer === 'view' || designer === 'edit',
    canViewArtworkFields: isAdmin || vendor || designer === 'view' || designer === 'edit',
    canEditDesignerFields: isAdmin || designer === 'edit',
    canEditArtworkFields: isAdmin || designer === 'edit',
    canOpenArtworkModal: isAdmin || vendor || designer === 'edit',
    canViewArtworkWorkspace: isAdmin || vendor || designer === 'view' || designer === 'edit',
    canUploadArtwork: isAdmin || vendor,
    canUploadArtworkFiles: isAdmin || vendor,
    canManageUploadStatus: isAdmin || designer === 'edit',
    canEditUploadStatus: isAdmin || designer === 'edit',
    canEditUploadNotes: isAdmin,
    canArchiveUploadSessions: isAdmin,
    canDeleteUploadSessions: isAdmin,
    canManageCatalog: isAdmin || purchaser,
    canManageCategories: isAdmin || purchaser,
    canManageItemNames: isAdmin || purchaser,
    canManageProductLines: isAdmin || purchaser,
    canCreatePackagingItems: isAdmin,
    canEditPackagingItems: isAdmin,
    canDeletePackagingItems: isAdmin,
  };

  for (const overrideKey of Object.keys(OVERRIDE_TO_ACCESS_KEY) as Array<keyof PermissionOverrides>) {
    const overrideValue = permissions.overrides[overrideKey];
    if (typeof overrideValue === 'boolean') {
      access[OVERRIDE_TO_ACCESS_KEY[overrideKey]] = overrideValue;
    }
  }

  if (access.canAssignInvoices && !access.canViewInvoices) {
    access.canAssignInvoices = false;
  }

  return access;
}

export function summarizeEffectiveAccess(access: ResolvedUserAccess): string[] {
  return ACCESS_KEYS.filter((key) => access[key]).map((key) =>
    key
      .replace(/^can/, '')
      .replace(/([A-Z])/g, ' $1')
      .trim()
  );
}

export function canAccessArtworkWorkspace(access: ResolvedUserAccess): boolean {
  return access.canViewArtworkWorkspace || access.canOpenArtworkModal || access.canViewDesignerFields;
}

export function canViewCustomers(access: ResolvedUserAccess): boolean {
  return access.canViewCustomers;
}

export function canViewReceivables(access: ResolvedUserAccess): boolean {
  return access.canViewReceivables;
}

export function canEditBusinessCentralItems(access: ResolvedUserAccess): boolean {
  return access.isAdmin || access.canManageCatalog;
}
