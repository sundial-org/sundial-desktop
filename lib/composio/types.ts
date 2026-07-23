export type ConnectedAppSummary = {
  toolkitSlug: string;
  name: string;
  logoUrl: string | null;
  appUrl: string | null;
  connectedAccountIds: string[];
  connectedCount: number;
  lastConnectedAt: string | null;
  updatedAt: string | null;
};

export type ToolkitCatalogEntry = {
  toolkitSlug: string;
  name: string;
  logoUrl: string | null;
};
