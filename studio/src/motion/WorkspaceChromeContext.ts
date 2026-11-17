import { createContext, useContext } from 'react';
import type { useWorkspace } from './useWorkspace';

export type WorkspaceChrome = {
  workspace: ReturnType<typeof useWorkspace>;
  switchingDisabled: boolean;
  saveState: string;
  openLibrary: (trigger?: HTMLElement, templateId?: string) => void;
  openConnections: () => void;
  openModelSettings: () => void;
  openHome: () => void;
  openAssets: () => void;
  assetsOpen: boolean;
  openSkills: () => void;
  skillsOpen: boolean;
  toggleSidebar: () => void;
  sidebarOpen: boolean;
  navigationCollapsed: boolean;
  toggleNavigation: () => void;
  settingsOpen?: boolean;
  registerEditor: (guard: EditorGuard | null) => void;
  beforeViewChange: () => Promise<void>;
};
export type EditorGuard = { waitForSaves: () => Promise<void>; blocked: boolean; saveState: string; message: string };
export const WorkspaceChromeContext = createContext<WorkspaceChrome | null>(null);
export const useOptionalWorkspaceChrome = () => useContext(WorkspaceChromeContext);
export function useWorkspaceChrome() {
  const value = useContext(WorkspaceChromeContext);
  if (!value) throw new Error('Workspace controls require WorkspaceFrame');
  return value;
}
