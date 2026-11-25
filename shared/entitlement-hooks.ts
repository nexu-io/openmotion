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
