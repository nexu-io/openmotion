import { brand } from "../index.js";

/** The same upstream symbol and product wordmark in every application entry. */
export function BrandLogo({ compact = false }: { compact?: boolean }) {
  return <span role="img" aria-label={brand.productName} className={`motion-brand-lockup${compact ? " motion-brand-lockup--responsive" : ""}`} />;
}
