import { guideUrl, isStreamableHttpTransport, type IntegrationInfo } from './integration.ts';

/** A continuation brief identifies saved work; it never carries provider credentials. */
export function projectAgentContext(info: Pick<IntegrationInfo, 'previewUrl' | 'dataDirectory'>, project: { id: string; title: string }, locale = 'en') {
  const origin = new URL(info.previewUrl).origin;
  const projectUrl = `${origin}/#project/${encodeURIComponent(project.id)}`;
  const connectionGuide = guideUrl({ previewUrl: origin }, 'mcp');
  if (locale === 'zh-CN') return `项目：${project.title}
项目 ID：${project.id}
工作区：${info.dataDirectory}
项目地址：${projectUrl}
接入指引：${connectionGuide}`;
  return `Project: ${project.title}
Project ID: ${project.id}
Workspace: ${info.dataDirectory}
Project URL: ${projectUrl}
Connection guide: ${connectionGuide}`;
}

export function projectAgentPrompt(
  info: Pick<IntegrationInfo, 'previewUrl' | 'dataDirectory'> & Partial<Pick<IntegrationInfo, 'transport'>>,
  project: { id: string; title: string },
  locale = 'en',
) {
  const cloud = isStreamableHttpTransport(info.transport);
  if (locale === 'zh-CN') {
    const connectFallback = cloud
      ? '如果当前会话尚未连接 OpenMotion MCP，请先读取上面的接入指引完成云端 MCP 注册与 OAuth 2.1 授权（不要安装本地运行时），再继续读取并编辑该项目。'
      : '如果当前会话尚未连接 OpenMotion MCP，请先读取上面的接入指引完成连接，再继续读取并编辑该项目。';
    return projectAgentContext(info, project, locale) + `\n\n请继续编辑这个 OpenMotion 项目。${connectFallback}先读取最新内容，再根据我的要求修改，保留已有内容和编辑历史。如果我还没有说明修改要求，先问我想改什么。完成后打开项目预览，方便我查看和继续调整。`;
  }
  const connectFallback = cloud
    ? 'If OpenMotion MCP is not connected in this session yet, read the connection guide above to register the cloud MCP server and complete OAuth 2.1 sign-in first (do not install a local runtime), then continue reading and editing this project.'
    : 'If OpenMotion MCP is not connected in this session yet, read the connection guide above to connect first, then continue reading and editing this project.';
  return projectAgentContext(info, project, locale) + `\n\nPlease continue editing this OpenMotion project. ${connectFallback} Read the latest content first, then make the changes I request, preserving existing content and edit history. If I have not specified any changes, ask me what I would like to change. When finished, open the project preview so I can review it and continue editing.`;
}
