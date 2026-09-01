import {
  BOLTZ_SKILL_MD,
  CELLXGENE_CENSUS_SKILL_MD,
  PAPERCLIP_SKILL_MD,
  PROTO_SKILL_MD,
} from '@/lib/local/starter-packs';

/**
 * Featured skills the Add-skill modal installs with one click. Content is the
 * same canned SKILL.md the research starter packs seed (starter-packs.ts holds
 * it because that module is the one file the Node sidecar can also load).
 */
export type FeaturedSkill = {
  id: string;
  name: string;
  /** One-liner on the featured card. */
  tagline: string;
  content: string;
  /** API key the skill needs, offered as an inline input on install. */
  secret?: { name: string; placeholder: string; createUrl: string };
};

export const FEATURED_SKILLS: readonly FeaturedSkill[] = [
  {
    id: 'paperclip',
    name: 'Paperclip',
    tagline: 'Search 11M+ full-text scientific papers, trials, and FDA docs by GXL.',
    content: PAPERCLIP_SKILL_MD,
    secret: {
      name: 'PAPERCLIP_API_KEY',
      placeholder: 'gxl_...',
      createUrl: 'https://paperclip.gxl.ai/keys',
    },
  },
  {
    id: 'cellxgene-census',
    name: 'CELLxGENE Census',
    tagline: 'Query ~218M single cells across 1,845 datasets by CZ Biohub. No API key.',
    content: CELLXGENE_CENSUS_SKILL_MD,
  },
  {
    id: 'proto',
    name: 'Proto',
    tagline: 'Run 140+ comp-bio tools (fold, design, dock, score) by Evo Design. No API key.',
    content: PROTO_SKILL_MD,
  },
  {
    id: 'boltz',
    name: 'Boltz',
    tagline: 'Predict 3D structure + binding affinity from sequence with Boltz-2. No API key.',
    content: BOLTZ_SKILL_MD,
  },
];
