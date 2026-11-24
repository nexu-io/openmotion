/**
 * My products: a product added once (photos, name, link, details) is reused by every
 * product studio. Photos are real workspace assets; the product list itself is kept in
 * this browser until a server-side product library exists.
 * TODO(backend): replace the localStorage list with a product library API
 * (list / create / update / delete, optionally reading name, price and selling points from the product link).
 */
export type StudioProductImage = { assetId: string; versionId: string; name: string };

export type StudioProduct = {
  id: string;
  name: string;
  url: string;
  description: string;
  images: StudioProductImage[];
  createdAt: number;
};

export const MAX_PRODUCT_IMAGES = 8;
const STORAGE_KEY = 'openmotion.studio.products.v1';

function isProduct(value: unknown): value is StudioProduct {
  const item = value as StudioProduct;
  return Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && Array.isArray(item.images)
    && item.images.every(image => image && typeof image.assetId === 'string' && typeof image.versionId === 'string'));
}

export function readProducts(): StudioProduct[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(isProduct).map(item => ({ ...item, url: item.url ?? '', description: item.description ?? '' }))
      : [];
  } catch {
    return [];
  }
}

function writeProducts(products: StudioProduct[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(products));
  } catch {
    // Private windows can refuse storage; the product still works for this session.
  }
}

/** Adds or replaces a product and returns the list, newest first. */
export function saveProduct(product: StudioProduct): StudioProduct[] {
  const next = [product, ...readProducts().filter(item => item.id !== product.id)];
  writeProducts(next);
  return next;
}

export function removeProduct(id: string): StudioProduct[] {
  const next = readProducts().filter(item => item.id !== id);
  writeProducts(next);
  return next;
}

/** Brief fields a product fills, for the studios that ask for one. */
export function productBrief(product: StudioProduct, fieldIds: ReadonlySet<string>): Record<string, string> {
  const brief: Record<string, string> = {};
  if (fieldIds.has('productName')) brief.productName = product.name;
  // Write empty values too, so switching products never keeps the previous product's details or link.
  if (fieldIds.has('productDescription')) brief.productDescription = product.description;
  if (fieldIds.has('pageUrl')) brief.pageUrl = product.url;
  return brief;
}

export const studioUsesProduct = (fieldIds: ReadonlySet<string>) => fieldIds.has('productName');
