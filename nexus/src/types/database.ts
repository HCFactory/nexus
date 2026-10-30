export type UserRole = "user" | "admin";
export type DimensionUnit = "mm" | "cm" | "in";
export type UploadStatus = "uploaded" | "approved" | "rejected";
export type ItemStatus = "new" | "in_progress" | "approved" | "superceded";
export type ItemOrderStatus = "new" | "final" | "cancel";
export type ItemPriority = "1_critical" | "2_standard" | "3_low";
export type InvoiceParty = "supplier" | "manufacturer";
export type InvoiceStatus = "draft" | "final" | "paid";
export type FriendsFamilyFulfillmentStatus = "new" | "packed" | "fulfilled";
export type FriendsFamilyPaymentStatus = "unpaid" | "cash_paid" | "square_paid" | "venmo_paid";
export type DesignerAccessLevel = "disabled" | "view" | "edit";
export type BusinessCentralSyncStatus =
  | "never_synced"
  | "synced"
  | "local_dirty"
  | "unpushed"
  | "syncing"
  | "failed"
  | "deleted_in_bc";
export type BusinessCentralSyncDirection =
  | "pull"
  | "push"
  | "create"
  | "delete"
  | "connection_test"
  | "reference_refresh";
export type BusinessCentralSyncEventStatus =
  | "success"
  | "failed"
  | "skipped"
  | "conflict_resolved";
export type BusinessCentralErrorClass =
  | "auth_failed"
  | "stale_etag"
  | "not_found"
  | "throttled"
  | "server_error"
  | "validation_error"
  | "network_error"
  | "conflict_resolved";

export interface FunctionalRoles {
  purchaser: boolean;
  vendor: boolean;
  designer: DesignerAccessLevel;
}

export interface PermissionOverrides {
  accessAdminPage?: boolean;
  manageUsers?: boolean;
  createOrder?: boolean;
  editOrderDate?: boolean;
  editOrderItems?: boolean;
  deleteOrderItems?: boolean;
  archiveOrders?: boolean;
  deleteOrders?: boolean;
  viewInvoices?: boolean;
  createInvoices?: boolean;
  editInvoices?: boolean;
  deleteInvoices?: boolean;
  assignInvoices?: boolean;
  viewCustomers?: boolean;
  viewReceivables?: boolean;
  viewDesignerFields?: boolean;
  editDesignerFields?: boolean;
  openArtworkModal?: boolean;
  uploadArtwork?: boolean;
  manageUploadStatus?: boolean;
  editUploadNotes?: boolean;
  archiveUploadSessions?: boolean;
  deleteUploadSessions?: boolean;
  manageCatalog?: boolean;
  createPackagingItems?: boolean;
  editPackagingItems?: boolean;
  deletePackagingItems?: boolean;
}

export interface UserPermissions {
  functionalRoles: FunctionalRoles;
  overrides: PermissionOverrides;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  organization_id: string | null;
  active_bc_connection_id: string | null;
  permissions: UserPermissions | null;
  permissions_version: number;
  permissions_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Organization {
  id: string;
  name: string;
  created_at: string;
}

export interface OrgMember {
  user_id: string;
  organization_id: string;
  role: string;
  created_at: string;
}

export interface OrgMemberWithOrg extends OrgMember {
  organization: Organization;
}

export interface Category {
  id: string;
  name: string;
  bc_connection_id: string | null;
  width: number | null;
  height: number | null;
  depth: number | null;
  unit: DimensionUnit;
  color: string | null;
  organization_id: string | null;
  bc_no_series_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductLine {
  id: string;
  name: string;
  bc_connection_id: string | null;
  organization_id: string | null;
  created_at: string;
}

export interface ItemName {
  id: string;
  name: string;
  bc_connection_id: string | null;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Item {
  id: string;
  item_name_id: string;
  bc_connection_id: string | null;
  category_id: string | null;
  product_line_id: string | null;
  version: string | null;
  status: ItemStatus;
  archived: boolean;
  organization_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  bc_item_id: string | null;
}

export interface ItemTemplate {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  name: string;
  description: string | null;
  category_id: string | null;
  bc_item_category_code: string | null;
  default_type: string;
  base_unit_of_measure_code: string | null;
  tax_group_code: string | null;
  general_product_posting_group_code: string | null;
  inventory_posting_group_code: string | null;
  price_includes_tax: boolean;
  blocked: boolean;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralCredentials {
  id: string;
  organization_id: string;
  tenant_id: string;
  client_id: string;
  client_secret_id: string | null;
  default_api_base_url: string | null;
  company_id: string | null;
  company_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralConnection {
  id: string;
  organization_id: string;
  environment: string;
  display_name: string;
  company_id: string;
  company_name: string | null;
  api_base_url: string;
  time_zone: string | null;
  sync_enabled: boolean;
  is_default: boolean;
  last_verified_at: string | null;
  last_error: string | null;
  last_pulled_at: string | null;
  sync_in_progress_by: string | null;
  sync_in_progress_since: string | null;
  sync_in_progress_timeout_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralReferenceRow {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_id: string;
  code: string;
  display_name: string;
  is_active: boolean;
  last_modified_at: string | null;
  last_refreshed_at: string;
  created_at: string;
  updated_at: string;
}

export type BusinessCentralItemCategory = BusinessCentralReferenceRow;

export interface BusinessCentralTaxGroup extends BusinessCentralReferenceRow {
  tax_type: string | null;
}

export interface BusinessCentralUnitOfMeasure extends BusinessCentralReferenceRow {
  international_standard_code: string | null;
  symbol: string | null;
}

export interface BusinessCentralGeneralProductPostingGroup extends BusinessCentralReferenceRow {
  default_vat_product_posting_group: string | null;
  auto_insert_default: boolean | null;
}

export type BusinessCentralInventoryPostingGroup = BusinessCentralReferenceRow;

export interface BusinessCentralItem {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_environment: string;
  bc_company_id: string;
  bc_item_id: string;
  bc_item_number: string | null;
  bc_etag: string | null;
  bc_last_modified_at: string | null;
  display_name: string;
  display_name_2: string | null;
  type: string | null;
  item_category_id: string | null;
  item_category_code: string | null;
  blocked: boolean;
  gtin: string | null;
  inventory: number | null;
  unit_price: number | null;
  price_includes_tax: boolean;
  unit_cost: number | null;
  tax_group_id: string | null;
  tax_group_code: string | null;
  base_unit_of_measure_id: string | null;
  base_unit_of_measure_code: string | null;
  general_product_posting_group_id: string | null;
  general_product_posting_group_code: string | null;
  inventory_posting_group_id: string | null;
  inventory_posting_group_code: string | null;
  bc_raw_payload: Record<string, unknown>;
  sync_status: BusinessCentralSyncStatus;
  sync_error: string | null;
  last_synced_at: string | null;
  last_pulled_at: string | null;
  last_pushed_at: string | null;
  local_last_edited_at: string | null;
  local_last_edited_by: string | null;
  client_request_id: string | null;
  deleted_in_bc_at: string | null;
  delete_confirmed_by: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralItemDetails {
  item_id: string;
  artwork_status: string | null;
  net_weight_grams: number | null;
  net_weight_oz: number | null;
  sams_club_item_number: string | null;
  units_per_case: number | null;
  costco_cases_per_layer: number | null;
  costco_layers_per_pallet: number | null;
  costco_units_per_pallet: number | null;
  sams_cases_per_layer: number | null;
  sams_layers_per_pallet: number | null;
  sams_units_per_pallet: number | null;
  custom_fields: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralItemSyncEvent {
  id: string;
  organization_id: string;
  item_id: string | null;
  run_id: string | null;
  direction: BusinessCentralSyncDirection;
  status: BusinessCentralSyncEventStatus;
  actor_user_id: string | null;
  actor_user_label: string | null;
  bc_item_id: string | null;
  bc_item_number: string | null;
  error_class: BusinessCentralErrorClass | null;
  error_message: string | null;
  changed_fields: string[] | null;
  request_summary: Record<string, unknown> | null;
  response_summary: Record<string, unknown> | null;
  before_snapshot: Record<string, unknown> | null;
  after_snapshot: Record<string, unknown> | null;
  created_at: string;
}

export interface ItemWithCategory extends Item {
  item_name: ItemName;
  category: Category | null;
  product_line: ProductLine | null;
}

export interface PackagingItemCombo {
  id: string;
  item_name_id: string;
  category_id: string;
  item_name: ItemName;
  category: Category;
  latest_item_id: string;
  latest_version: string | null;
  business_central_item_id: string | null;
}

export interface PurchaseVersionTarget {
  itemId: string;
  itemNameId: string;
  categoryId: string;
  productLineId: string | null;
  version: string | null;
  label: string;
  status: ItemStatus;
  updatedAt: string;
  itemName: ItemName;
  category: Category;
  productLine: ProductLine | null;
}

export interface LinkedPurchaseTargets {
  businessCentralItemRowId: string;
  linkedCombo: PackagingItemCombo | null;
  itemNameId: string | null;
  categoryId: string | null;
  targets: PurchaseVersionTarget[];
}

export interface PurchaseReferenceData {
  itemNames: ItemName[];
  categories: Category[];
  packagingItemCombos: PackagingItemCombo[];
}

export interface UploadSession {
  id: string;
  packaging_id: string;
  bc_connection_id: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
  notes: string | null;
  status: UploadStatus;
  archived: boolean;
  organization_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface UploadSessionWithDetails extends UploadSession {
  files: FileRecord[];
  uploader?: User;
}

export interface FileRecord {
  id: string;
  upload_session_id: string;
  file_name: string;
  file_size: number | null;
  file_type: string;
  storage_path: string;
  created_at: string;
}

export interface BarcodeFile {
  id: string;
  business_central_item_id: string;
  organization_id: string;
  bc_connection_id: string;
  file_name: string;
  file_size: number | null;
  file_type: string | null;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface OrgOrderSettings {
  organization_id: string;
  order_prefix: string;
  order_padding: number;
  current_sequence: number;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  order_number: string;
  order_sequence: number;
  order_date: string;
  created_by: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  item_name_id: string | null;
  category_id: string | null;
  version: string | null;
  approval_status: ItemStatus | null;
  notes: string | null;
  order_qty: number | null;
  item_order_status: ItemOrderStatus;
  priority: ItemPriority;
  sort_order: number;
  supplier_invoice_id: string | null;
  manufacturer_invoice_id: string | null;
  overrun_qty: number | null;
  accept_qty: number | null;
  supplier_inv_qty: number | null;
  manufacturer_inv_qty: number | null;
  overrun_qty_manual: boolean;
  accept_qty_manual: boolean;
  supplier_inv_qty_manual: boolean;
  manufacturer_inv_qty_manual: boolean;
  overrun_accepted: boolean;
  created_at: string;
  updated_at: string;
}

export interface OrderItemWithDetails extends OrderItem {
  item_name: ItemName | null;
  category: Category | null;
}

export interface PurchaseOrderWithItems extends PurchaseOrder {
  order_items: OrderItemWithDetails[];
}

export interface PurchaseInvoice {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  invoice_party: InvoiceParty;
  counterparty_name: string | null;
  invoice_number: string;
  invoice_date: string | null;
  invoice_due_date: string | null;
  status: InvoiceStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceOption {
  id: string;
  invoice_party: InvoiceParty;
  invoice_number: string;
  counterparty_name: string | null;
  status: InvoiceStatus;
  invoice_date: string | null;
  invoice_due_date: string | null;
  created_at: string;
}

export interface InvoiceAssignedOrderItem extends OrderItemWithDetails {
  order_number: string;
  order_date: string;
}

export interface PurchaseInvoiceWithAssignedItems extends PurchaseInvoice {
  assigned_items: InvoiceAssignedOrderItem[];
}

export interface EligibleInvoiceOrderItem extends OrderItemWithDetails {
  order_number: string;
  order_date: string;
}

export interface InvoiceWorkspaceData {
  invoices: PurchaseInvoiceWithAssignedItems[];
  eligible_items: Record<InvoiceParty, EligibleInvoiceOrderItem[]>;
}

export interface OrderItemInvoicePatch {
  orderItemId: string;
  supplier_invoice_id: string | null;
  manufacturer_invoice_id: string | null;
  supplier_inv_qty: number | null;
  manufacturer_inv_qty: number | null;
  supplier_inv_qty_manual: boolean;
  manufacturer_inv_qty_manual: boolean;
  updated_at: string;
}

export interface FriendsFamilyProduct {
  id: string;
  organization_id: string;
  name: string;
  category: string;
  unit_price: number;
  active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendsFamilyOrder {
  id: string;
  organization_id: string;
  order_number: string;
  order_sequence: number;
  ordered_by: string;
  customer_name: string;
  phone: string | null;
  email: string | null;
  fulfillment_status: FriendsFamilyFulfillmentStatus;
  payment_status: FriendsFamilyPaymentStatus;
  notes: string | null;
  total_amount: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface FriendsFamilyOrderItem {
  id: string;
  order_id: string;
  product_id: string | null;
  product_name: string;
  category_name: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  sort_order: number;
  created_at: string;
}

export interface FriendsFamilyOrderWithItems extends FriendsFamilyOrder {
  items: FriendsFamilyOrderItem[];
}

export interface FriendsFamilyWorkspace {
  products: FriendsFamilyProduct[];
  orders: FriendsFamilyOrderWithItems[];
}

export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: Omit<
          User,
          | "created_at"
          | "updated_at"
          | "permissions_updated_at"
          | "permissions_version"
          | "active_bc_connection_id"
        > & {
          created_at?: string;
          updated_at?: string;
          permissions_updated_at?: string | null;
          permissions_version?: number;
          active_bc_connection_id?: string | null;
        };
        Update: Partial<Omit<User, "id">>;
      };
      organizations: {
        Row: Organization;
        Insert: Omit<Organization, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<Organization, "id">>;
      };
      categories: {
        Row: Category;
        Insert: Omit<Category, "id" | "created_at" | "updated_at" | "bc_connection_id"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<Category, "id">>;
      };
      item_templates: {
        Row: ItemTemplate;
        Insert: Omit<ItemTemplate, "id" | "created_at" | "updated_at"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<ItemTemplate, "id">>;
      };
      product_lines: {
        Row: ProductLine;
        Insert: Omit<ProductLine, "id" | "created_at" | "bc_connection_id"> & {
          id?: string;
          created_at?: string;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<ProductLine, "id">>;
      };
      item_names: {
        Row: ItemName;
        Insert: Omit<ItemName, "id" | "created_at" | "updated_at" | "bc_connection_id"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<ItemName, "id">>;
      };
      items: {
        Row: Item;
        Insert: Omit<
          Item,
          | "id"
          | "created_at"
          | "updated_at"
          | "archived"
          | "product_line_id"
          | "version"
          | "status"
          | "bc_item_id"
          | "bc_connection_id"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          archived?: boolean;
          product_line_id?: string | null;
          version?: string | null;
          status?: ItemStatus;
          bc_item_id?: string | null;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<Item, "id">>;
      };
      upload_sessions: {
        Row: UploadSession;
        Insert: Omit<
          UploadSession,
          "id" | "created_at" | "updated_at" | "uploaded_at" | "status" | "bc_connection_id"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          uploaded_at?: string;
          status?: UploadStatus;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<UploadSession, "id">>;
      };
      files: {
        Row: FileRecord;
        Insert: Omit<FileRecord, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<FileRecord, "id">>;
      };
      purchase_orders: {
        Row: PurchaseOrder;
        Insert: Omit<
          PurchaseOrder,
          | "id"
          | "created_at"
          | "updated_at"
          | "order_number"
          | "order_sequence"
          | "archived"
          | "bc_connection_id"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          archived?: boolean;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<PurchaseOrder, "id">>;
      };
      order_items: {
        Row: OrderItem;
        Insert: Omit<
          OrderItem,
          | "id"
          | "created_at"
          | "updated_at"
          | "item_order_status"
          | "priority"
          | "sort_order"
          | "supplier_invoice_id"
          | "manufacturer_invoice_id"
          | "overrun_qty"
          | "accept_qty"
          | "supplier_inv_qty"
          | "manufacturer_inv_qty"
          | "overrun_qty_manual"
          | "accept_qty_manual"
          | "supplier_inv_qty_manual"
          | "manufacturer_inv_qty_manual"
          | "overrun_accepted"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          item_order_status?: ItemOrderStatus;
          priority?: ItemPriority;
          sort_order?: number;
          supplier_invoice_id?: string | null;
          manufacturer_invoice_id?: string | null;
          overrun_qty?: number | null;
          accept_qty?: number | null;
          supplier_inv_qty?: number | null;
          manufacturer_inv_qty?: number | null;
          overrun_qty_manual?: boolean;
          accept_qty_manual?: boolean;
          supplier_inv_qty_manual?: boolean;
          manufacturer_inv_qty_manual?: boolean;
          overrun_accepted?: boolean;
        };
        Update: Partial<Omit<OrderItem, "id">>;
      };
      purchase_invoices: {
        Row: PurchaseInvoice;
        Insert: Omit<
          PurchaseInvoice,
          "id" | "created_at" | "updated_at" | "status" | "bc_connection_id"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          status?: InvoiceStatus;
          bc_connection_id?: string | null;
        };
        Update: Partial<Omit<PurchaseInvoice, "id">>;
      };
      friends_family_products: {
        Row: FriendsFamilyProduct;
        Insert: Omit<FriendsFamilyProduct, "id" | "created_at" | "updated_at" | "active"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          active?: boolean;
        };
        Update: Partial<Omit<FriendsFamilyProduct, "id" | "organization_id">>;
      };
      friends_family_orders: {
        Row: FriendsFamilyOrder;
        Insert: Omit<FriendsFamilyOrder, "id" | "created_at" | "updated_at" | "fulfillment_status" | "payment_status"> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          fulfillment_status?: FriendsFamilyFulfillmentStatus;
          payment_status?: FriendsFamilyPaymentStatus;
        };
        Update: Partial<Omit<FriendsFamilyOrder, "id" | "organization_id" | "order_number" | "order_sequence">>;
      };
      friends_family_order_items: {
        Row: FriendsFamilyOrderItem;
        Insert: Omit<FriendsFamilyOrderItem, "id" | "created_at"> & { id?: string; created_at?: string };
        Update: Partial<Omit<FriendsFamilyOrderItem, "id" | "order_id">>;
      };

      business_central_connections: {
        Row: BusinessCentralConnection;
        Insert: Omit<
          BusinessCentralConnection,
          | "id"
          | "created_at"
          | "updated_at"
          | "api_base_url"
          | "sync_enabled"
          | "is_default"
          | "time_zone"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          api_base_url?: string;
          sync_enabled?: boolean;
          is_default?: boolean;
          time_zone?: string | null;
        };
        Update: Partial<Omit<BusinessCentralConnection, "id">>;
      };
      business_central_credentials: {
        Row: BusinessCentralCredentials;
        Insert: Omit<
          BusinessCentralCredentials,
          | "id"
          | "created_at"
          | "updated_at"
          | "client_secret_id"
          | "default_api_base_url"
          | "company_id"
          | "company_name"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          client_secret_id?: string | null;
          default_api_base_url?: string | null;
          company_id?: string | null;
          company_name?: string | null;
        };
        Update: Partial<Omit<BusinessCentralCredentials, "id">>;
      };
      business_central_item_categories: {
        Row: BusinessCentralItemCategory;
        Insert: Omit<
          BusinessCentralItemCategory,
          "id" | "created_at" | "updated_at" | "last_refreshed_at" | "is_active"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          last_refreshed_at?: string;
        };
        Update: Partial<Omit<BusinessCentralItemCategory, "id">>;
      };
      business_central_tax_groups: {
        Row: BusinessCentralTaxGroup;
        Insert: Omit<
          BusinessCentralTaxGroup,
          "id" | "created_at" | "updated_at" | "last_refreshed_at" | "is_active"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          last_refreshed_at?: string;
        };
        Update: Partial<Omit<BusinessCentralTaxGroup, "id">>;
      };
      business_central_units_of_measure: {
        Row: BusinessCentralUnitOfMeasure;
        Insert: Omit<
          BusinessCentralUnitOfMeasure,
          "id" | "created_at" | "updated_at" | "last_refreshed_at" | "is_active"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          last_refreshed_at?: string;
        };
        Update: Partial<Omit<BusinessCentralUnitOfMeasure, "id">>;
      };
      business_central_general_product_posting_groups: {
        Row: BusinessCentralGeneralProductPostingGroup;
        Insert: Omit<
          BusinessCentralGeneralProductPostingGroup,
          "id" | "created_at" | "updated_at" | "last_refreshed_at" | "is_active"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          last_refreshed_at?: string;
        };
        Update: Partial<Omit<BusinessCentralGeneralProductPostingGroup, "id">>;
      };
      business_central_inventory_posting_groups: {
        Row: BusinessCentralInventoryPostingGroup;
        Insert: Omit<
          BusinessCentralInventoryPostingGroup,
          "id" | "created_at" | "updated_at" | "last_refreshed_at" | "is_active"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          last_refreshed_at?: string;
        };
        Update: Partial<Omit<BusinessCentralInventoryPostingGroup, "id">>;
      };
      business_central_items: {
        Row: BusinessCentralItem;
        Insert: Omit<
          BusinessCentralItem,
          | "id"
          | "created_at"
          | "updated_at"
          | "blocked"
          | "price_includes_tax"
          | "bc_raw_payload"
          | "sync_status"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          blocked?: boolean;
          price_includes_tax?: boolean;
          bc_raw_payload?: Record<string, unknown>;
          sync_status?: BusinessCentralSyncStatus;
        };
        Update: Partial<Omit<BusinessCentralItem, "id">>;
      };
      business_central_item_details: {
        Row: BusinessCentralItemDetails;
        Insert: Omit<
          BusinessCentralItemDetails,
          "created_at" | "updated_at" | "custom_fields"
        > & {
          created_at?: string;
          updated_at?: string;
          custom_fields?: Record<string, unknown>;
        };
        Update: Partial<Omit<BusinessCentralItemDetails, "item_id">>;
      };
      business_central_item_sync_events: {
        Row: BusinessCentralItemSyncEvent;
        Insert: Omit<BusinessCentralItemSyncEvent, "id" | "created_at"> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<BusinessCentralItemSyncEvent, "id">>;
      };
      business_central_customers: {
        Row: BusinessCentralCustomer;
        Insert: Omit<
          BusinessCentralCustomer,
          | "id"
          | "created_at"
          | "updated_at"
          | "tax_liable"
          | "bc_raw_payload"
          | "sync_status"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          tax_liable?: boolean;
          bc_raw_payload?: Record<string, unknown>;
          sync_status?: BusinessCentralSyncStatus;
        };
        Update: Partial<Omit<BusinessCentralCustomer, "id">>;
      };
      business_central_sales_invoices: {
        Row: BusinessCentralSalesInvoice;
        Insert: Omit<
          BusinessCentralSalesInvoice,
          | "id"
          | "created_at"
          | "updated_at"
          | "bc_raw_payload"
          | "sync_status"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          bc_raw_payload?: Record<string, unknown>;
          sync_status?: BusinessCentralSyncStatus;
        };
        Update: Partial<Omit<BusinessCentralSalesInvoice, "id">>;
      };
      business_central_sales_invoice_lines: {
        Row: BusinessCentralSalesInvoiceLine;
        Insert: Omit<
          BusinessCentralSalesInvoiceLine,
          "id" | "created_at" | "updated_at" | "bc_raw_payload"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          bc_raw_payload?: Record<string, unknown>;
        };
        Update: Partial<Omit<BusinessCentralSalesInvoiceLine, "id">>;
      };
      business_central_customer_ledger_entries: {
        Row: BusinessCentralCustomerLedgerEntry;
        Insert: Omit<
          BusinessCentralCustomerLedgerEntry,
          "id" | "created_at" | "updated_at" | "open" | "bc_raw_payload"
        > & {
          id?: string;
          created_at?: string;
          updated_at?: string;
          open?: boolean;
          bc_raw_payload?: Record<string, unknown>;
        };
        Update: Partial<Omit<BusinessCentralCustomerLedgerEntry, "id">>;
      };
      business_central_sync_checkpoints: {
        Row: BusinessCentralSyncCheckpoint;
        Insert: Omit<
          BusinessCentralSyncCheckpoint,
          | "id"
          | "phase"
          | "records_synced"
          | "updated_at"
          | "completed_full_pass"
          | "last_completed_at"
        > & {
          id?: string;
          phase?: "backfill" | "delta";
          records_synced?: number;
          updated_at?: string;
          completed_full_pass?: boolean;
          last_completed_at?: string | null;
        };
        Update: Partial<Omit<BusinessCentralSyncCheckpoint, "id">>;
      };
      org_order_settings: {
        Row: OrgOrderSettings;
        Insert: Omit<
          OrgOrderSettings,
          "created_at" | "updated_at" | "current_sequence"
        > & {
          created_at?: string;
          updated_at?: string;
          current_sequence?: number;
        };
        Update: Partial<Omit<OrgOrderSettings, "organization_id">>;
      };
    };
  };
}

export type SyncEntityType =
  | 'customer'
  | 'sales_invoice'
  | 'sales_invoice_line'
  | 'customer_ledger_entry';

export interface BusinessCentralCustomer {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_environment: string;
  bc_company_id: string;
  bc_customer_id: string;
  bc_customer_number: string | null;
  bc_etag: string | null;
  bc_last_modified_at: string | null;
  display_name: string;
  type: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  phone_number: string | null;
  email: string | null;
  website: string | null;
  currency_id: string | null;
  currency_code: string | null;
  payment_terms_id: string | null;
  payment_method_id: string | null;
  shipment_method_id: string | null;
  tax_liable: boolean;
  tax_area_id: string | null;
  tax_registration_number: string | null;
  blocked: string | null;
  balance: number | null;
  overdue_amount: number | null;
  bc_raw_payload: Record<string, unknown>;
  sync_status: BusinessCentralSyncStatus;
  sync_error: string | null;
  last_synced_at: string | null;
  last_pulled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralSalesInvoice {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_environment: string;
  bc_company_id: string;
  bc_invoice_id: string;
  bc_invoice_number: string | null;
  external_document_number: string | null;
  bc_etag: string | null;
  bc_last_modified_at: string | null;
  invoice_date: string | null;
  posting_date: string | null;
  due_date: string | null;
  bc_customer_id: string | null;
  customer_number: string | null;
  customer_name: string | null;
  bill_to_customer_id: string | null;
  bill_to_customer_number: string | null;
  bill_to_name: string | null;
  currency_code: string | null;
  discount_amount: number | null;
  total_amount_excluding_tax: number | null;
  total_tax_amount: number | null;
  total_amount_including_tax: number | null;
  status: string | null;
  bc_raw_payload: Record<string, unknown>;
  sync_status: BusinessCentralSyncStatus;
  sync_error: string | null;
  last_synced_at: string | null;
  last_pulled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralSalesInvoiceLine {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_environment: string;
  bc_company_id: string;
  bc_line_id: string;
  bc_invoice_id: string;
  bc_etag: string | null;
  bc_last_modified_at: string | null;
  sequence: number | null;
  line_type: string | null;
  line_object_number: string | null;
  description: string | null;
  unit_of_measure_code: string | null;
  quantity: number | null;
  unit_price: number | null;
  discount_amount: number | null;
  discount_percent: number | null;
  tax_percent: number | null;
  amount_excluding_tax: number | null;
  tax_amount: number | null;
  amount_including_tax: number | null;
  bc_raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralCustomerLedgerEntry {
  id: string;
  organization_id: string;
  bc_connection_id: string | null;
  bc_environment: string;
  bc_company_id: string;
  entry_no: number;
  customer_no: string;
  posting_date: string | null;
  document_type: string | null;
  document_no: string | null;
  description: string | null;
  due_date: string | null;
  currency_code: string | null;
  amount: number | null;
  remaining_amount: number | null;
  open: boolean;
  closed_at_date: string | null;
  external_document_no: string | null;
  bc_raw_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BusinessCentralSyncCheckpoint {
  id: string;
  organization_id: string;
  bc_connection_id: string;
  entity_type: SyncEntityType;
  phase: 'backfill' | 'delta';
  cursor_value: string | null;
  records_synced: number;
  last_error: string | null;
  completed_full_pass: boolean;
  last_completed_at: string | null;
  updated_at: string;
}
