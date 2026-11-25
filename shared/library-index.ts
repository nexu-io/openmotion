export const UNIFIED_LIBRARY_CATEGORIES = [
  'all',
  'websites',
  'slides',
  'docs',
  'motion',
  'games',
  'images',
  'videos',
  'audio',
  'brand-kits',
  'workflows',
] as const;

export type UnifiedLibraryCategory = (typeof UNIFIED_LIBRARY_CATEGORIES)[number];

export const UNIFIED_LIBRARY_SORTS = ['newest', 'oldest', 'name'] as const;
export type UnifiedLibrarySort = (typeof UNIFIED_LIBRARY_SORTS)[number];

export const UNIFIED_LIBRARY_ORIGINS = [
  'all',
  'super-agent',
  'studio',
  'workflow',
  'mcp',
  'upload',
] as const;

export type UnifiedLibraryOrigin = (typeof UNIFIED_LIBRARY_ORIGINS)[number];

export type UnifiedLibraryItemKind =
  | 'asset'
  | 'motion-project'
  | 'motion-export'
  | 'design-project'
  | 'game-project'
  | 'brand-kit'
  | 'workflow-run'
  | 'super-agent-web';

export type UnifiedLibraryTarget =
  | { kind: 'asset'; assetId: string; versionId: string }
  | { kind: 'motion-project'; projectId: string }
  | { kind: 'motion-export'; projectId?: string; jobId: string; downloadUrl: string }
  | { kind: 'design-project'; projectId: string; scenario: string }
  | { kind: 'game-project'; gameId: string }
  | { kind: 'brand-kit'; kitId: string }
  | { kind: 'workflow-run'; scenarioId: string; runId: string }
  | { kind: 'super-agent'; chatId: string; artifactId?: string };

export type UnifiedLibraryItem = {
  id: string;
  kind: UnifiedLibraryItemKind;
  category: Exclude<UnifiedLibraryCategory, 'all'>;
  title: string;
  subtitle?: string;
  createdAt: number;
  updatedAt: number;
  origin: Exclude<UnifiedLibraryOrigin, 'all'>;
  originLabel: string;
  moduleLabel: string;
  badgeLabel?: string;
  sourceChatId?: string;
  sourceChatTitle?: string;
  sourceScenarioId?: string;
  sourceRunId?: string;
  sourceRunTitle?: string;
  previewUrl?: string;
  downloadUrl?: string;
  externalUrl?: string;
  mimeType?: string;
  filename?: string;
  bytes?: number;
  width?: number;
  height?: number;
  duration?: number;
  model?: string;
  canTrash?: boolean;
  target: UnifiedLibraryTarget;
};

export type UnifiedLibraryCounts = Record<UnifiedLibraryCategory, number>;

export type UnifiedLibraryQuery = {
  category?: UnifiedLibraryCategory;
  origin?: UnifiedLibraryOrigin;
  sort?: UnifiedLibrarySort;
  query?: string;
  offset?: number;
  limit?: number;
};

export type UnifiedLibraryResponse = {
  items: UnifiedLibraryItem[];
  counts: UnifiedLibraryCounts;
  total: number;
  nextOffset: number | null;
  generatedAt: number;
};

export function createEmptyLibraryCounts(): UnifiedLibraryCounts {
  return {
    all: 0,
    websites: 0,
    slides: 0,
    docs: 0,
    motion: 0,
    games: 0,
    images: 0,
    videos: 0,
    audio: 0,
    'brand-kits': 0,
    workflows: 0,
  };
}

export function designScenarioToLibraryCategory(
  scenario: string,
): 'websites' | 'slides' | 'docs' {
  if (scenario === 'deck') return 'slides';
  if (scenario === 'document') return 'docs';
  return 'websites';
}

export function isValidLibraryCategory(value: unknown): value is UnifiedLibraryCategory {
  return typeof value === 'string' && (UNIFIED_LIBRARY_CATEGORIES as readonly string[]).includes(value);
}

export function isValidLibraryOrigin(value: unknown): value is UnifiedLibraryOrigin {
  return typeof value === 'string' && (UNIFIED_LIBRARY_ORIGINS as readonly string[]).includes(value);
}

export function isValidLibrarySort(value: unknown): value is UnifiedLibrarySort {
  return typeof value === 'string' && (UNIFIED_LIBRARY_SORTS as readonly string[]).includes(value);
}
