import type { AuthContext } from '../contracts/auth.ts';
import { CloudError, isCloudError } from '../contracts/errors.ts';
import type { ProjectType } from '../db/schema/projects.ts';
import type { CatalogPort, CloneTemplateResult } from './catalog-service.ts';
import type { CreatedProjectResult, WorkspaceService } from './workspace-service.ts';

export interface ProjectCreationDeps {
  readonly workspace: Pick<WorkspaceService, 'createProject'>;
  readonly catalog?: Pick<CatalogPort, 'cloneTemplateToProject'>;
}

export interface CreateOrCloneProjectInput {
  readonly title?: string;
  readonly templateId?: string;
  /** True when `templateId` was inherited from a session rather than supplied by the caller. */
  readonly templateInherited?: boolean;
  readonly locale?: string;
  readonly projectType?: ProjectType;
  readonly requirements?: string;
  readonly namingLanguage?: string;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly initialPrompt?: string;
  readonly sourceMeta?: Record<string, unknown> | null;
  readonly selectActive?: boolean;
}

export interface CreateOrCloneProjectResult {
  readonly kind: 'cloned' | 'created';
  readonly projectId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly templateId?: string;
  readonly revision: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly replayed: boolean;
  readonly payload: CloneTemplateResult | CreatedProjectResult;
}

const INHERITED_TEMPLATE_FALLBACK_CODES = new Set([
  'TEMPLATE_NOT_COPYABLE',
  'TEMPLATE_MEDIA_UNAVAILABLE',
  'NOT_FOUND',
]);

/**
 * Shared project-creation capability backing `POST /motion-api/projects`,
 * `POST /motion-api/sessions/:id/artifacts`, and MCP `openmotion_create_project`.
 */
export async function createOrCloneProject(
  deps: ProjectCreationDeps,
  auth: AuthContext,
  input: CreateOrCloneProjectInput,
): Promise<CreateOrCloneProjectResult> {
  const templateId =
    typeof input.templateId === 'string' && input.templateId.trim() ? input.templateId.trim() : undefined;

  if (input.projectType === 'template' && !templateId) {
    throw new CloudError('INVALID_ARGUMENT', 'templateId is required when projectType=template', {
      status: 400,
      applied: false,
    });
  }

  let fallbackTemplateId = templateId;
  if (templateId && deps.catalog) {
    try {
      const cloned = await deps.catalog.cloneTemplateToProject(auth, {
        templateId,
        title: input.title,
        sessionId: input.sessionId,
        requirements: input.requirements ?? input.initialPrompt,
        namingLanguage: input.namingLanguage,
        requestId: input.requestId,
        locale: input.locale,
        activateWorkspace: input.selectActive !== false,
      });
      return {
        kind: 'cloned',
        projectId: cloned.projectId,
        sessionId: cloned.sessionId,
        title: cloned.title,
        templateId: cloned.templateId,
        revision: cloned.revision,
        versionId: cloned.versionId,
        versionNumber: cloned.versionNumber,
        replayed: false,
        payload: cloned,
      };
    } catch (error) {
      const code = isCloudError(error) ? error.code : undefined;
      const canFallback =
        input.projectType !== 'template' &&
        (code === 'TEMPLATE_NOT_COPYABLE' ||
          (input.templateInherited === true && code !== undefined && INHERITED_TEMPLATE_FALLBACK_CODES.has(code)));
      if (!canFallback) {
        throw error;
      }
      if (input.templateInherited === true && code !== 'TEMPLATE_NOT_COPYABLE') {
        fallbackTemplateId = undefined;
      }
    }
  }

  const created = await deps.workspace.createProject(auth, {
    title: input.title,
    templateId: fallbackTemplateId,
    projectType: input.projectType,
    requirements: input.requirements,
    namingLanguage: input.namingLanguage,
    sessionId: input.sessionId,
    requestId: input.requestId,
    initialPrompt: input.initialPrompt,
    sourceMeta: input.sourceMeta,
    selectActive: input.selectActive,
  });

  return {
    kind: 'created',
    projectId: created.projectId,
    sessionId: created.sessionId,
    title: created.title,
    ...(fallbackTemplateId ? { templateId: fallbackTemplateId } : {}),
    revision: created.revision,
    versionId: created.versionId,
    versionNumber: created.versionNumber,
    replayed: created.replayed,
    payload: created,
  };
}

export function formatProjectCreationHttpResponse(result: CreateOrCloneProjectResult): {
  status: 200 | 201;
  body: Record<string, unknown>;
} {
  if (result.kind === 'cloned') {
    return {
      status: 201,
      body: {
        ...result.payload,
        project: result.payload,
        projectTitle: result.title,
        replayed: false,
        exportJob: null,
      },
    };
  }
  return {
    status: result.replayed ? 200 : 201,
    body: {
      ...result.payload,
      projectTitle: result.title,
      exportJob: null,
    },
  };
}
