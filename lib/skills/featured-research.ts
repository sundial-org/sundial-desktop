/**
 * Research-flavor featured skills (the scientific/LaTeX beta): comp-bio
 * toolkits for the Add-skill modal. Moved here from lib/local/starter-packs.ts
 * when the general flavor took over the default list — only the modal reads
 * these now (Paperclip stays in starter-packs.ts because packs seed it).
 */
import { PAPERCLIP_SKILL_MD } from '@/lib/local/starter-packs';
import type { FeaturedSkill } from '@/lib/skills/featured';

// Bundled in the re:AGENT hackathon pack alongside Paperclip and installable
// from the Add-skill modal (lib/skills/featured.ts). Reference sections come
// from the official cellxgene-census docs; the "Known gotchas" block is from
// live testing on 2026-08-14, so it reflects the actual API, not guesses.
export const CELLXGENE_CENSUS_SKILL_MD = `---
name: CELLxGENE Census
description: >
  Queries the CZ CELLxGENE Discover Census (~218M single cells across 1,845
  datasets) with the cellxgene-census Python API, no API key. Use when the user
  asks about single-cell RNA-seq, cell types, marker-gene expression across
  tissues, diseases, or species, cell-type composition, or wants to build a
  single-cell dataset or meta-analysis.
---

# CELLxGENE Census

A standardized, versioned corpus of single-cell RNA-seq data (Chan Zuckerberg
Biohub / CELLxGENE), queried from Python. No account and no API key.

## Setup

Python 3.10 to 3.12. No credentials of any kind.

1. Install if missing (idempotent):
   \`python3 -c "import cellxgene_census" 2>/dev/null || pip install -U cellxgene-census\`
2. The first query downloads a small metadata index; cell data streams from S3
   on demand, so the sandbox needs outbound network but no local dataset.

## Before you start

Pin the release so results are reproducible:

\`\`\`python
import cellxgene_census
# a dated release, not "stable"/"latest", which drift between builds
census = cellxgene_census.open_soma(census_version="2025-11-08")
\`\`\`

\`"stable"\` and \`"latest"\` move between builds and print a warning naming the
current date. Pin that date instead and record it beside any number you report.

## Known gotchas (verified 2026-08-14)

These bite on the first query, so read them before writing any:

- **Narrow \`obs_value_filter\` BEFORE pulling expression.** An unscoped pull
  streams the whole matrix from S3 and hangs, "human blood B cells" alone is
  920,197 cells. Always add \`is_primary_data == True\` plus a specific
  \`tissue_general\` / \`cell_type\` / \`disease\`, and request only the genes you need
  via \`var_value_filter\`. Size a query with a cheap count (below) before
  materializing a matrix.
- **\`value_filter\` is a predicate string, NOT SQL.** It supports \`==\`, \`!=\`,
  \`in\`, \`and\`, \`or\`, and comparisons over obs/var columns, no \`SELECT\`, \`JOIN\`,
  or aggregation. Filter rows here; aggregate in pandas afterward. A column name
  that does not exist errors, so use the exact columns listed below.
- **\`experimental\` is not auto-imported.** \`cellxgene_census.experimental\`
  raises \`AttributeError\` until you \`import cellxgene_census.experimental\`
  explicitly. Needed for the precomputed cell embeddings.
- **Coarse vs fine tissue.** Use \`tissue_general\` for broad tissue (\`'blood'\`,
  \`'brain'\`, \`'lung'\`); \`tissue\` is fine-grained. Filtering on the wrong one
  silently returns far more or fewer cells than intended.
- **\`is_primary_data == True\` avoids double-counting.** The same cell can appear
  in several datasets; without this filter a count over-reports.
- **Prefer \`obs_column_names\` / \`var_column_names\`.** The older
  \`column_names={"obs": [...]}\` argument to \`get_anndata\` is deprecated and warns.

## Working style in a workspace

- Start from metadata: browse \`census_info/datasets\` and the obs schema to see
  what exists, decide the exact filter, then pull the smallest matrix that
  answers the question.
- Write the synthesis into the workspace files (e.g. \`findings.tex\`) as normal,
  reviewable edits, not left in tool output.
- Every number is reproducible from the pinned \`census_version\` plus the
  \`value_filter\`, record both next to the result, and cite the datasets by
  \`dataset_title\` / \`collection_name\` / \`citation\` from the datasets table.

---

_Reference below adapted from the official cellxgene-census docs
(chanzuckerberg.github.io/cellxgene-census). See the docsite for the
authoritative API._

## Corpus shape (verified 2026-08-14, release 2025-11-08)

- ~218M total cells, ~125M unique; 1,845 datasets; 5 organisms.
- Human: ~159M cells, 61,497 genes.
- Organisms (keys under \`census["census_data"]\`): \`homo_sapiens\`,
  \`mus_musculus\`, \`macaca_mulatta\`, \`callithrix_jacchus\`, \`pan_troglodytes\`. In
  \`get_anndata\`, name them \`"Homo sapiens"\`, \`"Mus musculus"\`, and so on.

## Cell metadata columns (\`obs\`), the \`value_filter\` fields

\`\`\`
soma_joinid, dataset_id, assay, assay_ontology_term_id, cell_type,
cell_type_ontology_term_id, development_stage, development_stage_ontology_term_id,
disease, disease_ontology_term_id, donor_id, is_primary_data, observation_joinid,
self_reported_ethnicity, self_reported_ethnicity_ontology_term_id, sex,
sex_ontology_term_id, suspension_type, tissue, tissue_ontology_term_id,
tissue_type, tissue_general, tissue_general_ontology_term_id, raw_sum, nnz,
raw_mean_nnz, raw_variance_nnz, n_measured_vars
\`\`\`

Gene metadata columns (\`var\`): \`soma_joinid, feature_id, feature_name,
feature_type, feature_length, nnz, n_measured_obs\`. Filter genes by
\`feature_name\` (symbol, e.g. \`'CD19'\`) or \`feature_id\` (Ensembl).

Inspect columns live without downloading data:

\`\`\`python
[f.name for f in census["census_data"]["homo_sapiens"].obs.schema]
\`\`\`

## Query recipes

**Cheap count (size a query before pulling a matrix):**

\`\`\`python
human = census["census_data"]["homo_sapiens"]
n = len(human.obs.read(
    value_filter="tissue_general == 'blood' and cell_type == 'B cell' and is_primary_data == True",
    column_names=["soma_joinid"],
).concat())
\`\`\`

**Cell metadata as a DataFrame:**

\`\`\`python
obs = human.obs.read(
    value_filter="tissue_general == 'tongue' and is_primary_data == True",
    column_names=["cell_type", "assay", "disease"],
).concat().to_pandas()
obs["cell_type"].value_counts()
\`\`\`

**Expression matrix into AnnData (scope tightly, name the genes):**

\`\`\`python
adata = cellxgene_census.get_anndata(
    census,
    organism="Homo sapiens",
    obs_value_filter="tissue_general == 'tongue' and is_primary_data == True",
    var_value_filter="feature_name in ['EPCAM', 'PTPRC']",
    obs_column_names=["cell_type", "disease"],
    var_column_names=["feature_name"],
)
# adata.X is raw counts; adata.obs / adata.var carry the metadata columns above.
\`\`\`

**Datasets table (meta-analysis entry point):**

\`\`\`python
ds = census["census_info"]["datasets"].read().concat().to_pandas()
# columns: soma_joinid, citation, collection_id, collection_name, collection_doi,
# collection_doi_label, dataset_id, dataset_version_id, dataset_title,
# dataset_h5ad_path, dataset_total_cell_count
\`\`\`

**Precomputed cell embeddings (experimental, explicit import):**

\`\`\`python
import cellxgene_census.experimental as ex
ex.get_all_available_embeddings("2025-11-08")  # scvi, tf-sapiens, tf-exemplar-human/mouse
\`\`\`

Always \`census.close()\`, or use \`with cellxgene_census.open_soma(...) as census:\`,
when done.
`;

// Bundled in the re:AGENT hackathon pack alongside Paperclip and Census, and
// installable from the Add-skill modal (lib/skills/featured.ts). Reference
// sections come from the official Proto docs (proto-tools agent-context); the
// "Known gotchas" block is from live testing on 2026-08-14, so it reflects the
// actual CLI/SDK, not guesses.
export const PROTO_SKILL_MD = `---
name: Proto
description: >
  Runs 140+ computational-biology tools (structure prediction, protein/RNA/DNA
  design, docking, inverse folding, sequence & structure alignment, genomic
  scoring, database retrieval) through the Proto CLI and typed Python SDK by Evo
  Design. Use when the user asks to predict or design a protein, RNA, or DNA
  sequence or structure, fold a sequence, dock a ligand, score variants, run a
  bioinformatics tool, or build a generative-biology pipeline. No API key for
  local, open-weight tools.
---

# Proto

One interface to 140+ computational-biology tools (Evo Design), each running in its own auto-built environment. Drive it from the sandbox shell: the \`proto-tools\` CLI to discover tools, its typed Python API to run one. No account and no API key for local, open-weight tools.

## Setup

Python 3.10+. No credentials for local, open-weight tools.

1. Install if missing (idempotent; it is a git install, no PyPI yet):
   \`python3 -c "import proto_tools" 2>/dev/null || pip install "proto-tools[mcp] @ git+https://github.com/evo-design/proto-tools.git"\`
2. For constraint-based sequence design (the propose-score-refine layer), also:
   \`python3 -c "import proto_language" 2>/dev/null || pip install "git+https://github.com/evo-design/proto-language.git"\`
3. The first call to any tool builds an isolated micromamba env for it under \`~/.proto/\` (cached after; roughly 30-60s cold, sub-second warm). This is normal, not a hang.

## Before you start

Discover offline with the CLI; do not guess tool keys or symbol names.

- \`proto-tools agent-context\` prints the primer: the \`Input -> Config -> run_*() -> Output\` pattern plus every discovery verb.
- \`proto-tools catalog\` lists tools grouped by category; \`proto-tools list --cpu\` shows the ones that run without a GPU.
- \`proto-tools signature <tool>\` gives the exact imports, run-function, and required fields; \`proto-tools example-input <tool>\` gives a minimal valid input; \`proto-tools access <tool>\` reports whether the weights are open, hf-gated, or request-only.

## Known gotchas (verified 2026-08-14)

These bite on the first command, so read them before writing any:

- **First run of a tool builds its env (roughly 30-60s), then it is cached.** A one-time micromamba setup runs on first use of each tool; warm re-runs are sub-second. Do not kill it as a hang.
- **Tool keys are \`<model>-<action>\`** (\`esmfold-prediction\`, \`viennarna-prediction\`), not \`esmfold\`. A rejected key prints near matches; \`proto-tools list\` resolves one you only half know.
- **Symbol names are not guessable from the key.** \`mafft-align\` exports \`MafftInput\`, not \`MafftAlignInput\`. Always run \`proto-tools signature <tool>\` before importing, rather than inventing the class name.
- **CPU by default; heavy models need a GPU.** ViennaRNA, sequence and structure alignment, ORF prediction, mutagenesis, gene annotation, and database retrieval run on CPU in the sandbox. Large models (Evo2, AlphaFold2/3, ESMFold, ESM3, Boltz2, RFdiffusion) need a GPU and only run when the user has Modal set up (\`device="modal"\`), so prefer a CPU tool unless the user asked for one of these and has Modal.
- **Gated weights need \`HF_TOKEN\`.** A few tools (ESM3, AlphaFold3, AlphaGenome) require accepting a license on HuggingFace and \`export HF_TOKEN=...\` first; \`proto-tools access <tool>\` flags these as \`hf-gated\`.
- **If you drive Proto's own MCP server instead of Python:** \`run_tool\` takes \`tool_key\` and \`inputs\` (not \`tool_id\`/\`input\`), and it DEFAULTS to \`run_on="modal"\`; pass \`run_on="local"\` for CPU tools or it errors on a missing Modal environment. Valid devices are \`local\`, \`modal\`, \`proto\`.

## Working style in a workspace

- Discover with the CLI, then run the smallest CPU tool that answers the question through the Python API. For example, fold an RNA sequence:

  \`\`\`python
  from proto_tools.tools.structure_prediction.viennarna.viennarna import (
      ViennaRNAInput,
      run_viennarna,
  )
  out = run_viennarna(ViennaRNAInput(sequences=["GGGAAACCC"]))
  print(out.results[0].structure, out.results[0].mfe)  # (((...))) -1.2
  \`\`\`

- Write the synthesis into the workspace files (e.g. \`findings.tex\`) as normal, reviewable edits, not left in tool output.
- Record the tool key, model, and inputs beside every result so it is reproducible, and cite the method by the DOI from \`proto-tools citation <tool>\`.

---

_Reference below adapted from the official Proto docs (\`proto-tools agent-context\`, proto.evodesign.org). Run \`proto-tools agent-context\` for the current version._

## The one pattern every tool follows

\`\`\`
Input -> Config -> run_*() -> Output
\`\`\`

\`Config\` is optional (the defaults are supplied). Every \`Output\` carries \`tool_id\`, \`execution_time\`, \`success\`, and \`errors\`, plus tool-specific \`results\`. Biological coordinates are 1-indexed and inclusive.

## Discovery CLI

| Verb | What it gives you |
|---|---|
| \`proto-tools list [--cpu/--gpu] [--category C]\` | Registered tools, one per line |
| \`proto-tools catalog\` | Tools grouped by category |
| \`proto-tools signature <tool>\` | Imports, run-function, and required fields |
| \`proto-tools example-input <tool>\` | A minimal valid Input |
| \`proto-tools schema/input/config/output <tool>\` | Field-level model docs and JSON Schema |
| \`proto-tools access <tool>\` | Weights access: open, hf-gated, or request |
| \`proto-tools citation <tool>\` | BibTeX and DOI for the method |
| \`proto-tools doctor\` | Check the environment can build tools and reach Modal |

## Categories (140+ tools)

\`structure_prediction\`, \`structure_design\`, \`structure_alignment\`, \`structure_scoring\`, \`structure_dynamics\`, \`causal_models\`, \`masked_models\`, \`inverse_folding\`, \`binder_design\`, \`molecular_docking\`, \`sequence_alignment\`, \`sequence_scoring\`, \`gene_annotation\`, \`orf_prediction\`, \`rna_splicing\`, \`mutagenesis\`, \`database_retrieval\`.

## Remote compute (optional)

Heavy or GPU-only tools can run in the user's own Modal workspace instead of locally: pass \`device="modal"\` to a run call (or \`program.run(device="modal")\` in proto-language). Deployment happens on first use and costs GPU time, so only reach for it when the user has Modal configured and has asked for a GPU tool. \`proto-tools doctor\` reports whether Modal is reachable.
`;


// Bundled into the re:AGENT hackathon pack and installable from the Add-skill
// modal (lib/skills/featured.ts). The reference below is drawn from Boltz's
// official docs (github.com/jwohlwend/boltz) plus gotchas verified in a
// 2026-08-14 CPU test cycle (weight size, cpu-accelerator default, affinity
// timing, boltz_results output layout, the MSA server, ligand_iptm).
export const BOLTZ_SKILL_MD = `---
name: Boltz
description: >
  Predicts 3D biomolecular structure and binding affinity from sequence with the
  open-source Boltz-2 model. Use when the user asks to fold a protein, model a
  protein complex or protein-ligand pair, predict a structure from a sequence,
  estimate binding affinity, or read pLDDT/pTM confidence for a predicted
  structure. No API key.
---

# Boltz

Boltz-2 (MIT, no API key) predicts the 3D structure of proteins, nucleic acids, and their complexes from sequence, and predicts protein-ligand binding affinity. Drive it from the sandbox with the \`boltz\` CLI: describe the molecule in a small YAML file, run \`boltz predict\`, and read the structure and confidence scores it writes.

## Setup

Python 3.10+. No credentials. Boltz is a sandbox (\`Bash\`) tool.

1. Put the ~4 GB weight cache on the persistent volume and install once:
   \`export BOLTZ_CACHE=/workspace/.boltz\`
   \`command -v boltz >/dev/null || pip install boltz\`
   Install plain \`boltz\` for CPU; \`boltz[cuda]\` only on an NVIDIA GPU.
2. Verify it runs: \`boltz predict --help >/dev/null && echo ok\`.

## Known gotchas (verified 2026-08-14, boltz 2.2.1, CPU)

Grounded in real runs on this stack; they bite on the first command:

- **Pass \`--accelerator cpu\` when there is no CUDA GPU.** The CLI default is \`gpu\`. Sandboxes are CPU by default; on Apple Silicon Boltz reports MPS available but runs on CPU, which is expected.
- **The first prediction downloads ~4 GB** to \`$BOLTZ_CACHE\` (conformer weights ~2.3 GB, affinity weights ~1.8 GB, and the CCD dictionary), printing only "Downloading…". It is a one-time cost **only if \`BOLTZ_CACHE\` is on the persistent volume**, otherwise it re-downloads every run.
- **Keep the first run tiny or it looks hung.** CPU time scales steeply with length and sampling steps. A ~33-residue chain with \`msa: empty --recycling_steps 1 --sampling_steps 25\` folds in seconds; the **affinity** pass adds minutes on CPU (~5.5 min in testing). Start small, then scale.
- **\`--use_msa_server\` calls the public MMseqs2 server** (api.colabfold.com) to build a real MSA (verified: it fetches uniref/bfd \`.a3m\` alignments). A real MSA meaningfully improves accuracy; use \`msa: empty\` only for a fast smoke test.
- **Output lands under \`boltz_results_<stem>/\`, not directly in \`--out_dir\`.** The ranked structure is \`<out_dir>/boltz_results_<stem>/predictions/<stem>/<stem>_model_0.{pdb,cif}\`; the scores are \`confidence_<stem>_model_0.json\` beside it; affinity is \`affinity_<stem>.json\`. Default format is mmcif; pass \`--output_format pdb\` for PDB.
- **Re-runs skip finished work** unless you pass \`--override\`.

## Input YAML

Minimal single protein (\`msa: empty\` is fast single-sequence mode; omit it and pass \`--use_msa_server\` for accuracy):

\`\`\`yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ
      msa: empty
\`\`\`

Entity types: \`protein\`, \`dna\`, \`rna\`, \`ligand\` (\`smiles:\` or \`ccd:\`). Repeat an \`id\` as a list (\`id: [A, B]\`) to make copies, e.g. a homodimer. For protein-ligand binding affinity, name the ligand as the binder:

\`\`\`yaml
version: 1
sequences:
  - protein:
      id: A
      sequence: MKTAYIAK...
      msa: empty
  - ligand:
      id: B
      smiles: 'CC(=O)Oc1ccccc1C(=O)O'
properties:
  - affinity:
      binder: B
\`\`\`

## Running

\`\`\`bash
export BOLTZ_CACHE=/workspace/.boltz
boltz predict inputs/protein.yaml --accelerator cpu --out_dir predictions \\
  --output_format pdb --recycling_steps 1 --sampling_steps 25 --override
\`\`\`

Drop the reduced steps for the accuracy defaults (3 recycling / 200 sampling) once a small run works. Other flags: \`--use_msa_server\`, \`--diffusion_samples N\`, \`--seed N\`. \`boltz predict --help\` lists them all.

## Reading the output

Report the real numbers from the JSON; never state a structure or score you did not produce:

- \`complex_plddt\`: mean confidence 0-1 (per-residue pLDDT is the PDB B-factor column, 0-100). > 0.7 confident, < 0.5 low.
- \`ptm\`: global fold confidence (0-1). \`iptm\` / \`ligand_iptm\`: interface confidence for complexes (0 for a single chain); > 0.8 is a reliable interface.
- Affinity: \`affinity_pred_value\` = log10 IC50 in µM (lower = stronger binder); \`affinity_probability_binary\` = 0-1 likelihood it binds.

## Working style in this workspace

Write the input to a YAML file (e.g. \`inputs/protein.yaml\`) as a normal edit, run Boltz, then write the result into \`findings.tex\` (or the workspace doc) as a reviewable edit: what was folded, the confidence numbers, and any caveat. Leave the predicted \`.pdb\`/\`.cif\` in the predictions folder. If pLDDT is low, say so and suggest what would help (a real MSA via \`--use_msa_server\`, more sampling steps, a better-defined input) rather than presenting a weak model as settled.
`;

export const RESEARCH_FEATURED_SKILLS: readonly FeaturedSkill[] = [
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
