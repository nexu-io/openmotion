export type SessionMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number };
/** Compatibility name for existing project conversation readers. */
export type ProjectMessage = SessionMessage;
export type ProjectConversation = { projectId: string; messages: ProjectMessage[] };

export function validateInstruction(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
    throw new Error('创作需求需要 1–8000 个字符');
  }
  return value.trim();
}

/** A handoff to an external Agent, never a claim that a task has been executed. */
export function projectInstruction(url: string, content: string) {
  return `请打开这个 OpenMotion 工程：${url}\n先调用 openmotion_get_project，核对当前 MCP 服务的 origin 与链接一致（若当前连在本地或其他环境，请先切到该链接对应的 /mcp 并优先走 OAuth 2.1 登录，切勿误判为工程不存在），确认 projectId 一致并读取该工程的 conversation 后再继续制作。\n\n${content}`;
}

export function sessionInstruction(url: string, sessionId: string, content: string) {
  return `继续这个 OpenMotion 会话：${url}\n先确认当前 MCP 服务的 origin 与链接一致（若当前连在本地或其他环境，请先切到该链接对应的 /mcp 并优先走 OAuth 2.1 登录）。再调用 openmotion_get_session（sessionId: ${sessionId}），读取模式、需求和 artifacts，按返回的 skill 与 templateId 制作。若没有产物，先用 openmotion_create_artifact 在这个会话中创建。操作前调用 openmotion_get_project，确认 projectId 与链接或所选产物一致；如不一致，用最新 revision 调用 openmotion_open_artifact 切到本会话对应的产物后再读取。不要覆盖其他会话的工程。\n\n${content}`;
}
