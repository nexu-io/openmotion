/**
 * The OpenGame repository changes PRODUCT_ID to 'opengame'.
 * Preserve each repository's value when synchronizing code.
 */
export type ProductId = 'openmotion' | 'opengame';
export const PRODUCT_ID: ProductId = 'openmotion' as const;
export const PRODUCT_UTM_SOURCE = PRODUCT_ID;

export function attributedEntryIdFor(product: ProductId, uuid: string): string {
  return product === 'openmotion' ? uuid : `${product}-${uuid}`;
}

export function attributedEntryId(uuid: string): string {
  return attributedEntryIdFor(PRODUCT_ID, uuid);
}
