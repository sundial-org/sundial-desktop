/**
 * Wire shape of GET /api/user/checklist — the "Get set up" steps computed
 * server-side by lib/user/checklist.ts. Kept in its own dependency-free
 * module because the checklist card ships in the static desktop export,
 * where the OSS boundary forbids importing the (server-side) query helper,
 * type-only included.
 */
export type ChecklistSteps = {
  project: boolean;
  agentEdit: boolean;
  commented: boolean;
  commentReply: boolean;
  shared: boolean;
};
