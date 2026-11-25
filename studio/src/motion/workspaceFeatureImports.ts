import { warmModule } from '../utils/chunkLoadRecovery';
import { preloadableComponent } from '../utils/preloadableComponent';

export const { Component: WorkspaceSearchResults, load: loadWorkspaceSearchResults } = preloadableComponent(
  () => import('./WorkspaceSearchResults'),
);
export const { Component: ImageMegaMenu, load: loadCreativeMediaMenu } = preloadableComponent(
  () => import('./ImageMegaMenu').then(module => ({ default: module.ImageMegaMenu })),
);
const videoMenu = preloadableComponent(() => import('./VideoMegaMenu').then(module => ({ default: module.VideoMegaMenu })));
const audioMenu = preloadableComponent(() => import('./AudioNavMenu').then(module => ({ default: module.AudioNavMenu })));
const workflowMenu = preloadableComponent(() => import('./ScenarioMegaMenu').then(module => ({ default: module.ScenarioMegaMenu })));

export const VideoMegaMenu = videoMenu.Component;
export const AudioNavMenu = audioMenu.Component;
export const ScenarioMegaMenu = workflowMenu.Component;
export const workspaceMenuImports = {
  image: loadCreativeMediaMenu,
  video: videoMenu.load,
  audio: audioMenu.load,
  workflows: workflowMenu.load,
};

export function preloadOnIntent(load: () => Promise<unknown>) {
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return;
  void warmModule(load);
}
