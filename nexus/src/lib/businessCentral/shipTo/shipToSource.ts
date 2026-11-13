import type { ReferenceSource } from '../customerReferences/transport';
import type { ShipToValues } from '@/types/salesOrders';

/** BC's published OData page 300 (ShipToAddresses). */
export const SHIP_TO_SOURCE: ReferenceSource = {
  kind: 'odata',
  service: 'ShipToAddresses',
  pageNumber: 300,
  keyFields: ['Customer_No', 'Code'],
};

/** Nexus column -> BC field, for every ship-to column except the code (part of the key). */
export const SHIP_TO_FIELDS: Record<Exclude<keyof ShipToValues, 'code'>, string> = {
  name: 'Name',
  address: 'Address',
  address_2: 'Address_2',
  city: 'City',
  state: 'County',
  post_code: 'Post_Code',
  country: 'Country_Region_Code',
  contact: 'Contact',
  phone: 'Phone_No',
  email: 'E_Mail',
  tax_area_code: 'Tax_Area_Code',
  tax_liable: 'Tax_Liable',
  location_code: 'Location_Code',
  shipment_method_code: 'Shipment_Method_Code',
};
