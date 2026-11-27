import {
  agentConnectionGuideUrl,
  isCloudIntegration,
  isStreamableHttpTransport,
  type IntegrationInfo,
  type PartialIntegrationHint,
} from './integration.ts';

export type ProjectAgentInfo = Pick<IntegrationInfo, 'previewUrl' | 'dataDirectory'> & PartialIntegrationHint;

/** A continuation brief identifies saved work; it never carries provider credentials. */
export function projectAgentContext(info: ProjectAgentInfo, project: { id: string; title: string }, locale = 'en') {
  const origin = new URL(info.previewUrl).origin;
  const projectUrl = `${origin}/#project/${encodeURIComponent(project.id)}`;
  const cloud = isCloudIntegration(info);
  const mcpUrl = isStreamableHttpTransport(info.transport) ? info.transport.url : `${origin}/mcp`;
  const connectionGuide = agentConnectionGuideUrl(info, 'mcp');
  if (locale === 'zh-CN') {
    return [
      `项目：${project.title}`,
      `项目 ID：${project.id}`,
      info.dataDirectory ? `工作区：${info.dataDirectory}` : null,
      `项目地址：${projectUrl}`,
      cloud ? `MCP 端点：${mcpUrl}` : null,
      `接入指引：${connectionGuide}`,
    ].filter(Boolean).join('\n');
  }
  return [
    `Project: ${project.title}`,
    `Project ID: ${project.id}`,
    info.dataDirectory ? `Workspace: ${info.dataDirectory}` : null,
    `Project URL: ${projectUrl}`,
    cloud ? `MCP endpoint: ${mcpUrl}` : null,
    `Connection guide: ${connectionGuide}`,
  ].filter(Boolean).join('\n');
}

export function projectAgentPrompt(info: ProjectAgentInfo, project: { id: string; title: string }, locale = 'en') {
  const cloud = isCloudIntegration(info);
  if (cloud) {
    return projectAgentContext(info, project, locale) + (locale === 'zh-CN'
      ? '\n\n请继续编辑这个 OpenMotion 项目。如果当前尚未接入上述云端 MCP 端点，或仍连接着旧版 local stdio OpenMotion MCP / 本地插件，请先按接入指引移除旧本地配置并完成云端 MCP 接入与 OAuth 授权（保留本地工程文件，不要执行新建模板引导，完成后直接继续本项目）。先读取最新内容，再根据我的要求修改，保留已有内容和编辑历史。如果我还没有说明修改要求，先问我想改什么。完成后打开项目预览，方便我查看和继续调整。'
      : '\n\nPlease continue editing this OpenMotion project. If this Agent is not yet connected to the cloud MCP endpoint above, or still routes to a legacy local stdio OpenMotion MCP server or local plugin, follow the connection guide to remove the legacy local registration and connect via OAuth 2.1 first (keep local project files intact, skip generic template onboarding, and resume this project directly). Read the latest content first, then make the changes I request, preserving existing content and edit history. If I have not specified any changes, ask me what I would like to change. When finished, open the project preview so I can review it and continue editing.');
  }
  return projectAgentContext(info, project, locale) + (locale === 'zh-CN'
    ? '\n\n请继续编辑这个 OpenMotion 项目。先读取最新内容，再根据我的要求修改，保留已有内容和编辑历史。如果我还没有说明修改要求，先问我想改什么。完成后打开项目预览，方便我查看和继续调整。'
    : '\n\nPlease continue editing this OpenMotion project. Read the latest content first, then make the changes I request, preserving existing content and edit history. If I have not specified any changes, ask me what I would like to change. When finished, open the project preview so I can review it and continue editing.');
}
