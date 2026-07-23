'use client';

// A local project renders through the exact same WorkspacePage as cloud
// workspaces — the layout's route context (`local`) swaps the data plane to
// the desktop sidecar. No parallel UI.
export { default } from '../../w/[slug]/page';
