// Reports for the Skills page and the Brand Kit page. Event, area, element and field names follow the
// same page_name + area + element convention as the template library, so the funnels read alike.
// The pages call these and own no tracking code of their own; nothing here may throw into them.
import { slug } from '../../../tracking/core.ts';
import type { BrandKit } from '../../../shared/brand-kit';
import type { MotionSkill, SkillParameters } from './skillCatalog';
import { embeddedView, newTrackingId, searchKeyword, send, slugField, type Fields } from './reporting';

export { newTrackingId };
type Click = Fields<'ui_click'>;
/** The page view carries the same shell context as the studio page view, so the funnels segment alike. */
const shell = (hasProject: boolean) => ({ view_id: newTrackingId(), embedded: embeddedView(), has_project: hasProject });

// ---------- Skills ----------
const skills = { page_name: 'skills' } as const;
const CATEGORY = { 'Product promos': 'product_promos', Explainers: 'explainers', 'Brand & covers': 'brand_covers', 'Motion techniques': 'motion_techniques' } as const;
export const skillCategoryId = (category: MotionSkill['category']) => CATEGORY[category];
/** A catalogue id is sent only when it is a bounded slug; anything else is left out, never rewritten. */
const skillFields = (skill: MotionSkill) => ({ ...slugField('skill_id', skill.id), skill_category: skillCategoryId(skill.category) });

export function reportSkillsPageView(hasProject: boolean) {
  send('page_view', { ...skills, ...shell(hasProject) });
}
/** `category` null is the「All」button. */
export function reportSkillCategory(category: MotionSkill['category'] | null, resultCount: number) {
  send('ui_click', { ...skills, area: 'skill_discovery', element: 'category_select', selected: category !== null,
    ...(category ? { skill_category: skillCategoryId(category) } : {}), result_count: resultCount });
}
export function reportSkillFiltersCleared() {
  send('ui_click', { ...skills, area: 'skill_discovery', element: 'filter_clear' });
}
export function reportSkillSearch(searchId: string, query: string, resultCount: number, category: MotionSkill['category'] | null) {
  const keyword = searchKeyword(query);
  if (!keyword) return;
  send('skill_search_result', { ...skills, area: 'skill_discovery', search_id: searchId, search_keyword: keyword, query_length: query.trim().length,
    result_count: resultCount, outcome: 'success', ...(category ? { skill_category: skillCategoryId(category) } : {}) });
}
export function reportSkillCardOpened(skill: MotionSkill, position: number, searchId: string | undefined) {
  send('ui_click', { ...skills, area: 'skill_card', element: 'open_detail', ...skillFields(skill), position, ...(searchId ? { search_id: searchId } : {}) });
}
export function reportSkillDetailShown(skill: MotionSkill, detailViewId: string) {
  send('surface_view', { ...skills, area: 'skill_detail', element: 'detail', ...skillFields(skill), detail_view_id: detailViewId });
}
export function reportSkillDetailClick(skill: MotionSkill, element: Extract<Click['element'], 'copy_instruction' | 'open_command' | 'view_source' | 'close_detail'>,
  detailViewId: string | undefined, copyAttemptId?: string) {
  send('ui_click', { ...skills, area: 'skill_detail', element, ...skillFields(skill), ...(detailViewId ? { detail_view_id: detailViewId } : {}),
    ...(copyAttemptId ? { copy_attempt_id: copyAttemptId } : {}) });
}
export function reportSkillCommandCopyClicked(skill: MotionSkill, detailViewId: string | undefined, copyAttemptId: string) {
  send('ui_click', { ...skills, area: 'skill_command', element: 'copy_command', ...skillFields(skill), copy_attempt_id: copyAttemptId,
    ...(detailViewId ? { detail_view_id: detailViewId } : {}) });
}
/** Only `clipboard_written` is a successful copy; showing the text for a manual copy is not. The brief is reduced to its choices. */
export function reportSkillCopyResult(skill: MotionSkill, surface: 'instruction' | 'command', status: 'clipboard_written' | 'manual_fallback_shown',
  copyAttemptId: string, parameters: SkillParameters, detailViewId: string | undefined) {
  if (!slug.test(skill.id)) return;
  send('skill_instruction_copy_result', { ...skills, skill_id: skill.id, skill_category: skillCategoryId(skill.category), copy_surface: surface, copy_status: status,
    copy_attempt_id: copyAttemptId, duration_seconds: parameters.duration, aspect_ratio: parameters.aspect,
    has_subject: parameters.subject.trim().length > 0, has_style: parameters.style.trim().length > 0, media_required: Boolean(skill.media),
    ...(detailViewId ? { detail_view_id: detailViewId } : {}) });
}
export function reportSkillSubmitClicked() {
  send('ui_click', { ...skills, area: 'skill_intro', element: 'submit_skill' });
}

// ---------- Brand Kit ----------
const brandPage = { page_name: 'brand_kit' } as const;
export type BrandCollection = 'official' | 'mine';
/** An official kit is named by its catalogue id; the user's own kit is reported only as「mine」. */
export const brandFields = (kit: Pick<BrandKit, 'catalogId'>) => kit.catalogId && slug.test(kit.catalogId)
  ? { brand_source: 'official' as const, catalog_id: kit.catalogId } : { brand_source: kit.catalogId ? 'official' as const : 'mine' as const };

export function reportBrandKitPageView(collection: BrandCollection, hasProject: boolean) {
  send('page_view', { ...brandPage, ...shell(hasProject), brand_collection: collection });
}
export function reportBrandCollectionTab(collection: BrandCollection) {
  send('ui_click', { ...brandPage, area: 'brand_collection', element: 'collection_tab', brand_collection: collection });
}
export function reportNewBrandKitClicked(collection: BrandCollection) {
  send('ui_click', { ...brandPage, area: 'brand_library', element: 'new_brand_kit', brand_collection: collection });
}
export function reportBrandSurprise(collection: BrandCollection, resultCount: number) {
  send('ui_click', { ...brandPage, area: 'brand_library', element: 'surprise_me', brand_collection: collection, result_count: resultCount });
}
/** `success` means the extraction was accepted and started; whether the kit later becomes ready is a server-side result. */
export function reportBrandKitCreateResult(outcome: 'success' | 'failure', createAttemptId: string) {
  send('brand_kit_create_result', { ...brandPage, outcome, create_attempt_id: createAttemptId });
}
/** A card in「My brand kits」was opened. Official cards report through the import result. */
export function reportBrandCardOpened(kit: Pick<BrandKit, 'catalogId'>, position: number | undefined) {
  send('ui_click', { ...brandPage, area: 'brand_card', element: 'open_detail', ...brandFields(kit), ...(position ? { position } : {}) });
}
export function reportBrandKitImportResult(catalogId: string, outcome: 'success' | 'failure', alreadyInLibrary: boolean, position: number | undefined) {
  if (!slug.test(catalogId)) return;
  send('brand_kit_import_result', { ...brandPage, catalog_id: catalogId, outcome, already_in_library: alreadyInLibrary, ...(position ? { position } : {}) });
}
export function reportBrandDetailShown(kit: Pick<BrandKit, 'catalogId' | 'state'>, detailViewId: string) {
  send('surface_view', { ...brandPage, area: 'brand_detail', element: 'detail', ...brandFields(kit), brand_state: kit.state, detail_view_id: detailViewId });
}
export function reportBrandDetailClick(kit: Pick<BrandKit, 'catalogId'>, element: Extract<Click['element'], 'copy_instruction' | 'download_package' | 'detail_previous' | 'detail_next'>,
  detailViewId: string | undefined, attempt: { copy_attempt_id?: string; download_attempt_id?: string } = {}) {
  send('ui_click', { ...brandPage, area: 'brand_detail', element, ...brandFields(kit), ...attempt, ...(detailViewId ? { detail_view_id: detailViewId } : {}) });
}
export function reportBrandCopyResult(kit: Pick<BrandKit, 'catalogId'>, status: 'clipboard_written' | 'failed', copyAttemptId: string, detailViewId: string | undefined) {
  send('brand_kit_instruction_copy_result', { ...brandPage, ...brandFields(kit), copy_status: status, copy_attempt_id: copyAttemptId,
    ...(detailViewId ? { detail_view_id: detailViewId } : {}) });
}
/** `browser_save_requested` means the ZIP was handed to the browser; nothing confirms the file reached disk. */
export function reportBrandDownloadResult(kit: Pick<BrandKit, 'catalogId'>, status: 'browser_save_requested' | 'fetch_failed', downloadAttemptId: string, detailViewId: string | undefined) {
  send('resource_download_result', { ...brandPage, resource_kind: 'brand_kit_package', download_attempt_id: downloadAttemptId, delivery_status: status, ...brandFields(kit),
    ...(detailViewId ? { detail_view_id: detailViewId, detail_mode: 'modal' as const } : {}) });
}
export function reportBrandActionResult(kit: Pick<BrandKit, 'catalogId'>, action: Fields<'brand_kit_action_result'>['action'], outcome: 'success' | 'failure', detailViewId: string | undefined) {
  send('brand_kit_action_result', { ...brandPage, ...brandFields(kit), action, outcome, ...(detailViewId ? { detail_view_id: detailViewId } : {}) });
}
