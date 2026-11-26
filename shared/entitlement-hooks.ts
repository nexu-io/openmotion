export const ENTITLEMENT_HOOK_IDS = [
  'header_signin',
  'settings_signin',
  'template_use',
  'private_link_gate',
  'assets_empty',
  'studio_generate',
  'cloud_export',
  'session_expired_401',
  'header_pricing',
  'bf_banner',
  'bf_hero',
  'bf_hub',
  'settings_subscription',
  'studio_free_gate',
  'model_picker_upgrade',
  'studio_res_gate',
  'failure_card_topup',
  'mcp_oauth',
] as const;

export type EntitlementHookId = (typeof ENTITLEMENT_HOOK_IDS)[number];

const ENTITLEMENT_HOOK_ID_SET: ReadonlySet<string> = new Set(ENTITLEMENT_HOOK_IDS);

export function isEntitlementHookId(value: string): value is EntitlementHookId {
  return ENTITLEMENT_HOOK_ID_SET.has(value);
}

/** Hosted product analytics covers the commercial funnel. Local Studio has its own event policy. */
export function isCloudEntitlementEvent(event: unknown, properties: unknown): boolean {
  if (!properties || typeof properties !== 'object') return false;
  const { hook_id, page_name, area, element } = properties as Record<string, unknown>;
  if (hook_id !== undefined && (typeof hook_id !== 'string' || !isEntitlementHookId(hook_id))) return false;
  if (event === 'entitlement_refresh_result') return true;
  if (event === 'ui_click' && page_name === 'settings') {
    if (area === 'account') return element === 'sign_in' || element === 'manage_subscription' || element === 'view_plans';
    if (area === 'provider_detail') return element === 'view_plans';
  }
  if (hook_id === undefined) return false;
  if (event === 'surface_view') return (area === 'entitlement_modal' && element === 'modal')
    || (hook_id === 'bf_banner' && area === 'campaign_banner' && element === 'banner');
  if (event !== 'ui_click') return false;
  switch (area) {
    case 'entitlement_modal': return element === 'sign_in' || element === 'view_plans';
    case 'entitlement_gate': return element === 'sign_in' || element === 'view_plans' || element === 'open_pricing';
    case 'header': return hook_id === 'header_pricing' && element === 'open_pricing';
    case 'campaign_banner': return hook_id === 'bf_banner' && element === 'claim_offer';
    default: return false;
  }
}
