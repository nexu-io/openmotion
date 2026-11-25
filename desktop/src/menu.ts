import type { MenuItemConstructorOptions } from 'electron';
import type { DesktopMenuAction, DesktopPlatform, DesktopUpdateState } from '../../shared/platform-host.ts';
import { resolveUpdaterMenuPresentation } from './ux-controllers.ts';

export const DOCS_URL = 'https://github.com/nexu-io/openmotion/tree/main/docs';
export const RELEASES_URL = 'https://github.com/nexu-io/openmotion/releases';
export const REPORT_ISSUE_URL = 'https://github.com/nexu-io/openmotion/issues/new/choose';

type MenuLabels = {
  about: (version: string) => string;
  checkUpdates: string;
  settings: string;
  confirmBeforeQuit: string;
  quit: string;
  file: string;
  newProject: string;
  edit: string;
  view: string;
  back: string;
  forward: string;
  reloadWorkspace: string;
  resetZoom: string;
  zoomIn: string;
  zoomOut: string;
  agentsAndMcp: string;
  connectAgentMcp: string;
  agentRuntimes: string;
  help: string;
  helpCenter: string;
  documentation: string;
  whatsNew: string;
  exportDiagnosticLogs: string;
  openLogsFolder: string;
  reportIssue: string;
  joinFeishu: string;
  joinDiscord: string;
  openWorkspace: string;
  environment: string;
  activeEnvironment: (label: string) => string;
  switchEnvironment: string;
  recentEnvironments: string;
  clearEnvironmentData: string;
  copyEnvironmentInfo: string;
  resetEnvironment: string;
};

const EN_LABELS: MenuLabels = {
  about: version => `About OpenDesign (${version})`,
  checkUpdates: 'Check for Updates…',
  settings: 'Settings…',
  confirmBeforeQuit: 'Confirm Before Quitting',
  quit: 'Quit OpenDesign',
  file: 'File',
  newProject: 'New Project',
  edit: 'Edit',
  view: 'View',
  back: 'Back',
  forward: 'Forward',
  reloadWorkspace: 'Reload Workspace',
  resetZoom: 'Actual Size',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  agentsAndMcp: 'Agents & MCP',
  connectAgentMcp: 'Connect Agent via MCP…',
  agentRuntimes: 'Agent Runtimes, Bridges & Batch…',
  help: 'Help',
  helpCenter: 'Help Center',
  documentation: 'Documentation',
  whatsNew: "What's New / Releases",
  exportDiagnosticLogs: 'Export Diagnostic Logs…',
  openLogsFolder: 'Open Logs Folder',
  reportIssue: 'Report an Issue…',
  joinFeishu: 'Join Community (Feishu)',
  joinDiscord: 'Join Community (Discord)',
  openWorkspace: 'Open Workspace',
  environment: 'Environment',
  activeEnvironment: label => `Active: ${label}`,
  switchEnvironment: 'Switch Environment / Orbit Lane…',
  recentEnvironments: 'Recent Environments',
  clearEnvironmentData: 'Clear Current Environment Data & Reload',
  copyEnvironmentInfo: 'Copy Environment Diagnostics',
  resetEnvironment: 'Reset to Default Environment',
};

const ZH_LABELS: MenuLabels = {
  about: version => `关于 OpenDesign (${version})`,
  checkUpdates: '检查更新…',
  settings: '设置…',
  confirmBeforeQuit: '退出前确认',
  quit: '退出 OpenDesign',
  file: '文件',
  newProject: '新建项目',
  edit: '编辑',
  view: '视图',
  back: '后退',
  forward: '前进',
  reloadWorkspace: '重新加载工作区',
  resetZoom: '实际大小',
  zoomIn: '放大',
  zoomOut: '缩小',
  agentsAndMcp: '智能体与 MCP',
  connectAgentMcp: '通过 MCP 连接智能体…',
  agentRuntimes: '智能体运行时与桥接…',
  help: '帮助',
  helpCenter: '帮助中心',
  documentation: '文档',
  whatsNew: '版本更新说明',
  exportDiagnosticLogs: '导出诊断日志…',
  openLogsFolder: '打开日志文件夹',
  reportIssue: '反馈问题…',
  joinFeishu: '加入社群（飞书）',
  joinDiscord: '加入社群（Discord）',
  openWorkspace: '打开工作区',
  environment: '测试环境',
  activeEnvironment: label => `当前：${label}`,
  switchEnvironment: '切换环境 / Orbit 泳道…',
  recentEnvironments: '最近使用',
  clearEnvironmentData: '清除当前环境缓存与登录态并重载',
  copyEnvironmentInfo: '复制环境诊断信息',
  resetEnvironment: '恢复默认环境',
};

function resolveMenuLabels(locale?: string): MenuLabels {
  if (locale && locale.toLowerCase().startsWith('zh')) {
    return ZH_LABELS;
  }
  return EN_LABELS;
}

export function buildDesktopDockMenuTemplate(options: {
  locale?: string;
  updateState?: DesktopUpdateState;
  onAction: (action: DesktopMenuAction) => void;
  onInstallUpdate?: () => void;
  onFocusMainWindow?: () => void;
}): MenuItemConstructorOptions[] {
  const labels = resolveMenuLabels(options.locale);
  const updaterMenu = resolveUpdaterMenuPresentation(options.updateState, options.locale);
  return [
    ...(options.onFocusMainWindow
      ? [
          {
            label: labels.openWorkspace,
            click: () => options.onFocusMainWindow?.(),
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: labels.newProject,
      click: () => options.onAction('new-project'),
    },
    {
      label: labels.connectAgentMcp,
      click: () => options.onAction('open-mcp-connect'),
    },
    { type: 'separator' },
    {
      label: updaterMenu.label,
      enabled: updaterMenu.enabled,
      click: () => {
        if (updaterMenu.action === 'install' && options.onInstallUpdate) {
          options.onInstallUpdate();
        } else {
          options.onAction('check-updates');
        }
      },
    },
  ];
}

export type DesktopMenuEnvironmentPreset = {
  label: string;
  url: string;
  active: boolean;
};

export type DesktopMenuEnvironmentOptions = {
  activeLabel: string;
  activeUrl: string;
  isCustomOverride: boolean;
  presets: readonly DesktopMenuEnvironmentPreset[];
  recent: readonly DesktopMenuEnvironmentPreset[];
  onSelectUrl: (url: string) => void;
  onOpenSwitcher: () => void;
  onResetDefault: () => void;
  onClearEnvironmentData: () => void;
  onCopyEnvironmentInfo: () => void;
};

export function buildDesktopMenuTemplate(options: {
  platform: DesktopPlatform;
  appVersion: string;
  locale?: string;
  includeDevItems?: boolean;
  updateState?: DesktopUpdateState;
  confirmBeforeQuit?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  environment?: DesktopMenuEnvironmentOptions;
  onAction: (action: DesktopMenuAction) => void;
  onOpenUrl: (url: string) => void;
  onOpenLogsFolder?: () => void;
  onInstallUpdate?: () => void;
  onNavigateBack?: () => void;
  onNavigateForward?: () => void;
  onToggleConfirmBeforeQuit?: (enabled: boolean) => void;
  onZoomChange?: (direction: 'in' | 'out' | 'reset') => void;
}): MenuItemConstructorOptions[] {
  const {
    platform,
    appVersion,
    locale,
    includeDevItems = false,
    updateState,
    confirmBeforeQuit = true,
    canGoBack,
    canGoForward,
    environment,
    onAction,
    onOpenUrl,
    onOpenLogsFolder,
    onInstallUpdate,
    onNavigateBack,
    onNavigateForward,
    onToggleConfirmBeforeQuit,
    onZoomChange,
  } = options;
  const isMac = platform === 'darwin';
  const labels = resolveMenuLabels(locale);
  const updaterMenu = resolveUpdaterMenuPresentation(updateState, locale);

  const updaterMenuItem: MenuItemConstructorOptions = {
    label: updaterMenu.label,
    enabled: updaterMenu.enabled,
    click: () => {
      if (updaterMenu.action === 'install' && onInstallUpdate) {
        onInstallUpdate();
      } else {
        onAction('check-updates');
      }
    },
  };

  const confirmQuitMenuItem: MenuItemConstructorOptions[] = onToggleConfirmBeforeQuit
    ? [
        {
          label: labels.confirmBeforeQuit,
          type: 'checkbox',
          checked: confirmBeforeQuit,
          click: menuItem => onToggleConfirmBeforeQuit(Boolean(menuItem.checked)),
        },
      ]
    : [];

  const template: MenuItemConstructorOptions[] = [];

  if (isMac) {
    template.push({
      label: 'OpenDesign',
      submenu: [
        { role: 'about' },
        updaterMenuItem,
        { type: 'separator' },
        {
          label: labels.settings,
          accelerator: 'CmdOrCtrl+,',
          click: () => onAction('open-settings'),
        },
        ...confirmQuitMenuItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  template.push({
    label: labels.file,
    submenu: [
      {
        label: labels.newProject,
        accelerator: 'CmdOrCtrl+N',
        click: () => onAction('new-project'),
      },
      { type: 'separator' },
      ...(isMac
        ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
        : ([
            {
              label: labels.settings,
              accelerator: 'CmdOrCtrl+,',
              click: () => onAction('open-settings'),
            },
            ...confirmQuitMenuItem,
            { type: 'separator' },
            { role: 'close' },
            {
              label: labels.quit,
              accelerator: 'CmdOrCtrl+Q',
              role: 'quit',
            },
          ] as MenuItemConstructorOptions[])),
    ],
  });

  template.push({
    label: labels.edit,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? [
            { role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions,
            { role: 'delete' } as MenuItemConstructorOptions,
            { role: 'selectAll' } as MenuItemConstructorOptions,
          ]
        : [
            { role: 'delete' } as MenuItemConstructorOptions,
            { type: 'separator' } as MenuItemConstructorOptions,
            { role: 'selectAll' } as MenuItemConstructorOptions,
          ]),
    ],
  });

  template.push({
    label: labels.view,
    submenu: [
      ...(onNavigateBack || onNavigateForward
        ? ([
            {
              label: labels.back,
              accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
              ...(typeof canGoBack === 'boolean' ? { enabled: canGoBack } : {}),
              click: () => onNavigateBack?.(),
            },
            {
              label: labels.forward,
              accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
              ...(typeof canGoForward === 'boolean' ? { enabled: canGoForward } : {}),
              click: () => onNavigateForward?.(),
            },
            { type: 'separator' },
          ] as MenuItemConstructorOptions[])
        : []),
      {
        label: labels.reloadWorkspace,
        accelerator: 'CmdOrCtrl+R',
        click: () => onAction('reload-app'),
      },
      ...(includeDevItems
        ? ([
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
          ] as MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      ...(onZoomChange
        ? ([
            {
              label: labels.resetZoom,
              accelerator: 'CmdOrCtrl+0',
              click: () => onZoomChange('reset'),
            },
            {
              label: labels.zoomIn,
              accelerator: 'CmdOrCtrl+Plus',
              click: () => onZoomChange('in'),
            },
            {
              label: labels.zoomOut,
              accelerator: 'CmdOrCtrl+-',
              click: () => onZoomChange('out'),
            },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
          ] as MenuItemConstructorOptions[])),
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });

  template.push({
    label: labels.agentsAndMcp,
    submenu: [
      {
        label: labels.connectAgentMcp,
        click: () => onAction('open-mcp-connect'),
      },
      {
        label: labels.agentRuntimes,
        click: () => onAction('open-agent-runtimes'),
      },
    ],
  });

  if (environment) {
    const presetUrls = new Set(environment.presets.map(item => item.url));
    const recentItems = environment.recent.filter(item => !presetUrls.has(item.url));
    template.push({
      label: labels.environment,
      submenu: [
        {
          label: labels.activeEnvironment(environment.activeLabel),
          enabled: false,
        },
        { type: 'separator' },
        ...environment.presets.map(
          preset =>
            ({
              label: preset.label,
              type: 'radio',
              checked: preset.active,
              click: () => environment.onSelectUrl(preset.url),
            }) as MenuItemConstructorOptions,
        ),
        { type: 'separator' },
        {
          label: labels.switchEnvironment,
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => environment.onOpenSwitcher(),
        },
        ...(recentItems.length > 0
          ? ([
              {
                label: labels.recentEnvironments,
                submenu: recentItems.map(item => ({
                  label: item.label,
                  type: 'radio',
                  checked: item.active,
                  click: () => environment.onSelectUrl(item.url),
                })),
              },
            ] as MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        {
          label: labels.clearEnvironmentData,
          click: () => environment.onClearEnvironmentData(),
        },
        {
          label: labels.copyEnvironmentInfo,
          click: () => environment.onCopyEnvironmentInfo(),
        },
        {
          label: labels.resetEnvironment,
          enabled: environment.isCustomOverride,
          click: () => environment.onResetDefault(),
        },
      ],
    });
  }

  template.push({
    role: 'windowMenu',
    submenu: isMac
      ? [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ]
      : [
          { role: 'minimize' },
          { role: 'close' },
        ],
  });

  template.push({
    role: 'help',
    label: labels.help,
    submenu: [
      {
        label: labels.helpCenter,
        click: () => onAction('open-help'),
      },
      {
        label: labels.documentation,
        click: () => onOpenUrl(DOCS_URL),
      },
      {
        label: labels.whatsNew,
        click: () => onOpenUrl(RELEASES_URL),
      },
      { type: 'separator' },
      {
        label: labels.exportDiagnosticLogs,
        click: () => onAction('export-logs'),
      },
      ...(onOpenLogsFolder
        ? [
            {
              label: labels.openLogsFolder,
              click: () => onOpenLogsFolder(),
            } as MenuItemConstructorOptions,
          ]
        : []),
      {
        label: labels.reportIssue,
        click: () => onOpenUrl(REPORT_ISSUE_URL),
      },
      { type: 'separator' },
      {
        label: labels.joinFeishu,
        click: () => onAction('join-community-feishu'),
      },
      {
        label: labels.joinDiscord,
        click: () => onAction('join-community-discord'),
      },
      ...(!isMac
        ? [
            { type: 'separator' } as MenuItemConstructorOptions,
            updaterMenuItem,
            {
              label: labels.about(appVersion),
              click: () => onAction('open-about'),
            } as MenuItemConstructorOptions,
          ]
        : []),
    ],
  });

  return template;
}
