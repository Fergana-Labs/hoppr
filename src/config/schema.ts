import { z } from 'zod'

/**
 * Config schema. Defaults live here, so `defaults()` and validation can never
 * drift apart. Every value the tool reads must be declared in this file.
 */
export const PROVIDERS = [
  'auto',
  'openrouter',
  'anthropic',
  'openai',
  'ollama',
  'claude-cli',
  'claude-agent-sdk',
  'none',
] as const

export const ConfigSchema = z.object({
  hopper: z
    .object({
      /** Human name; the directory under ~/.hoppr is the identity. */
      name: z.string().default('default'),
      /** One line telling an agent when to reach for THIS hoppr. */
      description: z.string().default(''),
      /** dir:<path> | agents:<harness,…> | manual */
      source: z.string().default('manual'),
      /**
       * `reference` leaves raw inputs exactly where they are and records only
       * provenance — hoppr never opens them for writing. `copy` keeps a durable
       * capture when the upstream owner may change or remove the original.
       */
      raw_mode: z.enum(['reference', 'copy']).default('copy'),
      /** Which curation stages run. */
      profile: z.enum(['folder', 'agents', 'manual']).default('manual'),
      /**
       * Convenience for `hoppr init --exclude`. `.hopprignore` beside the data
       * is the real mechanism and the one to reach for — this exists so a
       * one-off exclusion at creation time does not require writing a file.
       */
      exclude: z.array(z.string()).default([]),
      /** Skip files larger than this when indexing a folder. */
      max_file_mb: z.number().positive().default(20),
      /** Read the folder's own .gitignore. `.hopprignore` always applies. */
      use_gitignore: z.boolean().default(true),
      /**
       * What this hoppr is FOR: notes | papers | agents | index-only | minimal.
       * A preset over the switches below — every one stays overridable.
       */
      curation: z.string().optional(),
    })
    .prefault({}),

  git: z
    .object({
      /** 'auto' = one commit per curate pass, message = the curator's log entry. */
      mode: z.enum(['auto', 'off']).default('auto'),
    })
    .prefault({}),

  wiki: z
    .object({
      layout: z.enum(['karpathy', 'flat']).default('karpathy'),
      /** A tag earns a concept page once this many source pages carry it. */
      concept_min_sources: z.number().int().positive().default(4),
      /** index.md is generated deterministically, not written by the model. */
      generate_index: z.boolean().default(true),
      claude_md: z.boolean().default(true),
      /**
       * Which page types this hoppr may create. `source` and `concept` are
       * implemented; the others are in the layout spec but not built, so
       * listing them here promises pages that never appear.
       */
      page_types: z.array(z.string()).default(['source', 'concept']),
      /**
       * One paragraph telling an agent what this corpus IS and what it is for,
       * written into the wiki's front door and the MCP server's instructions.
       *
       * This is the highest-leverage string in the config: an agent that knows
       * "these are support transcripts from 2024-25, use them for policy
       * precedent" retrieves differently from one that knows only "documents".
       * Empty ⇒ generated from the source and profile.
       */
      orientation: z.string().default(''),
      /**
       * An explicit outline: folders and files you want to exist, each with a
       * prompt saying what belongs in it.
       *
       * The generated wiki is emergent — pages appear because captures
       * clustered that way. That is right for discovery and wrong for the
       * three or four pages you know you want up front: an overview, a
       * glossary, an open-questions list. Naming them means they exist from
       * day one and the curator has an instruction for each, rather than you
       * hoping the clustering produces something similar.
       *
       * Long enough to deserve its own file: see `schemas/wiki.toml`.
       */
      outline: z
        .array(
          z.object({
            /** Path under `curated/wiki/`, e.g. "overview.md" or "areas/". */
            path: z.string(),
            /** Given to the model verbatim as the brief for this page. */
            prompt: z.string().default(''),
            /** Rebuild every deep pass, or write once and leave alone. */
            mode: z.enum(['maintain', 'once']).default('maintain'),
          }),
        )
        .default([]),
    })
    .prefault({}),

  intake: z
    .object({
      inbox: z.string().default('inbox'),
      /** Scrub credentials at the extraction boundary. On by default: hoppr
       *  reads agent logs, and those contain pasted keys. */
      redact: z.boolean().default(true),
      /** The entropy net beneath the vendor patterns. */
      redact_entropy: z.boolean().default(true),
      /**
       * How much of a rendered transcript to keep, and how much of each tool
       * result inside it.
       *
       * These are STORAGE limits, applied once at capture and therefore
       * permanent. They were 60,000 and 400, and the 400 was the damaging one:
       * a tool result is where a command failed and what it said, which is the
       * entire payload for skill mining — "the failures are the point" is not
       * true of a result cut off at 400 characters.
       *
       * Curation has its own, much smaller budget (`curate.max_raw_chars`)
       * applied at READ time, so keeping more here costs disk rather than
       * tokens.
       */
      transcript_max_chars: z.number().int().positive().default(400_000),
      tool_result_max_chars: z.number().int().positive().default(8_000),
      redact_patterns: z.array(z.string()).default([]),
      debounce_ms: z.number().int().positive().default(20_000),
      max_wait_ms: z.number().int().positive().default(120_000),
    })
    .prefault({}),

  index: z
    .object({
      driver: z.enum(['auto', 'better-sqlite3', 'node-sqlite']).default('auto'),
      chunk_chars: z.number().int().positive().default(3200),
      chunk_overlap: z.number().int().nonnegative().default(320),
    })
    .prefault({}),

  llm: z
    .object({
      provider: z.enum(PROVIDERS).default('auto'),
      /**
       * Tagging and extraction run per item, in volume. They belong on a raw
       * HTTP API call — sub-second and cheap — never on a CLI subprocess that
       * pays ~30s and ~11k cached prompt tokens per invocation. Override the
       * tier here to put tagging on a cheap fast model and synthesis on a
       * better one.
       */
      fast_provider: z.enum(PROVIDERS).optional(),
      quality_provider: z.enum(PROVIDERS).optional(),
      /** Unset uses a per-provider default: an HTTP call and a CLI subprocess
       *  are an order of magnitude apart, so one number cannot fit both. */
      timeout_ms: z.number().int().positive().optional(),
      /**
       * Leave unset to use each provider's own default. Model IDs are
       * provider-specific — "claude-haiku-4-5" is meaningless to OpenRouter,
       * which wants "anthropic/claude-haiku-4.5" — so a single shared default
       * silently misconfigures whichever provider it was not written for.
       */
      models: z
        .object({
          fast: z.string().optional(),
          quality: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),

  embed: z
    .object({
      provider: z.enum(['local', 'openai', 'voyage', 'gemini', 'none']).default('local'),
      model: z.string().default('Xenova/bge-small-en-v1.5'),
      dim: z.number().int().positive().default(384),
      batch: z.number().int().positive().default(32),
    })
    .prefault({}),

  curate: z
    .object({
      fast_batch: z.number().int().positive().default(8),
      deep_cron: z.string().default('0 3 * * *'),
      /**
       * Curated paths the agent must never rewrite, as globs relative to
       * `curated/`.
       *
       * Hand-editing a page already pins it — the agent notices and backs off.
       * This is the version you set BEFORE writing anything, so a page you
       * intend to own is protected from the first pass rather than from the
       * first time you happen to edit it.
       */
      protect: z.array(z.string()).default([]),
      budget: z
        .object({
          max_usd_per_day: z.number().nonnegative().default(2.0),
          max_calls_per_run: z.number().int().positive().default(200),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * What gets INDEXED, and how a query is answered.
   *
   * Split from [search] because these are two different decisions: what you
   * pay to build, and how you rank what you built. Turning an arm off here
   * means it is never populated, not merely never queried.
   */
  retrieval: z
    .object({
      /**
       * BM25. Not a toggle: it is free, it is the floor every other arm falls
       * back to, and a store you cannot grep is not a store.
       */
      keyword: z.literal(true).default(true),
      /** Vector search. Costs a model download; nothing leaves the machine. */
      embeddings: z.boolean().default(true),
      /** Typed entities and relations. See [graph]. */
      graph: z.boolean().default(false),
      /** Per-extractor toggles — the expensive parts of "index this folder". */
      extract: z
        .object({
          /** Local OCR over images. Free, ~800ms each. */
          ocr: z.boolean().default(true),
          /** A vision model describing what an image SHOWS. Costs per image. */
          image_llm: z.boolean().default(true),
          /** PDF text layers. */
          pdf: z.boolean().default(true),
          /** Rasterise + OCR a PDF with no text layer. */
          pdf_ocr: z.boolean().default(true),
          /** Word, Excel, PowerPoint. */
          office: z.boolean().default(true),
        })
        .prefault({}),
      rerank: z
        .object({
          /**
           * rrf     — rank-based fusion. Needs no calibration between bm25's
           *           unbounded negatives and cosine's 0..2, which is why it
           *           is the default.
           * weighted— normalise each arm to 0..1 and blend. Tunable, but the
           *           normalisation is per-query and therefore unstable.
           * none    — keyword only, arms not fused. Cheapest to reason about.
           */
          method: z.enum(['rrf', 'weighted', 'none']).default('rrf'),
          /** RRF's damping constant. Larger ⇒ flatter, more democratic. */
          k: z.number().int().positive().default(60),
          /** weighted only: relative arm weights. */
          weights: z
            .object({ keyword: z.number().default(1), vector: z.number().default(1) })
            .prefault({}),
        })
        .prefault({}),
    })
    .prefault({}),

  /**
   * Typed entities and relations over the corpus.
   *
   * Off by default and schema-driven on purpose: a relation vocabulary is
   * domain-specific, and inventing one for a folder of papers produces
   * confident nonsense. Define the types you actually have.
   */
  graph: z
    .object({
      /**
       * These are PROMPTS, not validation rules.
       *
       * A type's `description` is handed to the model verbatim as the
       * definition of what counts. That is where the accuracy comes from:
       * "person" retrieves everything and nothing, while "person — a named
       * individual who participated, not an author cited in passing" is a
       * decision procedure. Write them as instructions to a careful reader.
       *
       * A bare string is shorthand for a type with no description, which works
       * and is worse.
       */
      entity_types: z
        .array(
          z.union([
            z.string(),
            z.object({ name: z.string(), description: z.string().default('') }),
          ]),
        )
        .default(['person', 'org', 'project', 'tool', 'concept']),
      /** `subject -> predicate -> object`, restricted to the types above. */
      relations: z
        .array(
          z.object({
            name: z.string(),
            from: z.array(z.string()).default([]),
            to: z.array(z.string()).default([]),
            /** When this relation applies — again, given to the model verbatim. */
            description: z.string().default(''),
          }),
        )
        .default([]),
      /** Skip an entity seen fewer times than this — a hapax is noise. */
      min_mentions: z.number().int().positive().default(2),
    })
    .prefault({}),

  search: z
    .object({
      default_scope: z.enum(['curated', 'raw', 'all']).default('curated'),
      limit: z.number().int().positive().default(10),
      tier_boost: z.record(z.string(), z.number()).default({ curated: 1.5 }),
      kind_boost: z
        .record(z.string(), z.number())
        .default({ concept: 1.2, digest: 1.2, skill: 1.1 }),
      confidence_boost: z
        .record(z.string(), z.number())
        .default({ high: 1.15, medium: 1.0, low: 0.8 }),
      recency_half_life_days: z.number().positive().default(180),
      max_snippet_chars: z.number().int().positive().default(400),
    })
    .prefault({}),

  skills: z
    .object({
      enabled: z.boolean().default(true),
      min_evidence: z.number().int().positive().default(3),
      min_confidence: z.number().min(0).max(1).default(0.6),
      default_target: z.string().default('~/.claude/skills'),
      /**
       * auto      — cluster transcripts and propose whatever recurs.
       * targeted  — only mine the subjects named in `targets`.
       * off       — never mine; hand-written skills still install.
       *
       * `targeted` exists because auto-mining a corpus you know well mostly
       * re-proposes things you already know. Naming the gaps is more useful
       * than being told what you do most often.
       */
      mine: z.enum(['auto', 'targeted', 'off']).default('auto'),
      /** Subjects to look for in `targeted` mode, in plain language. */
      targets: z.array(z.string()).default([]),
      /**
       * Skills seeded on init, as slugs from the packaged set. These are the
       * ones worth having before any mining has happened — they encode how
       * YOU work, which no amount of transcript clustering will discover in
       * the first week.
       */
      seed: z.array(z.string()).default(['comms-preferences', 'working-agreements']),
    })
    .prefault({}),

  views: z
    .object({
      enabled: z.boolean().default(true),
    })
    .prefault({}),

  daemon: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7717),
    })
    .prefault({}),

  /** User-defined frontmatter fields the curator must fill on every page. */
  schema: z
    .record(
      z.string(),
      z.object({
        type: z.enum(['string', 'number', 'boolean', 'date', 'enum', 'list']),
        values: z.array(z.string()).optional(),
        description: z.string().optional(),
        applies_to: z.array(z.string()).optional(),
      }),
    )
    .prefault({}),

  tables: z.record(z.string(), z.record(z.string(), z.unknown())).default({
    tags: {
      vocabulary_size: 150,
      max_new_tags_per_item: 2,
      max_tags_per_item: 7,
      pinned: ['work', 'personal'],
      stoplist: ['misc', 'other', 'stuff', 'general'],
    },
  }),

  connectors: z
    .record(
      z.string(),
      z
        .object({
          enabled: z.boolean().default(true),
          poll_seconds: z.number().int().positive().default(60),
          max_chars: z.number().int().positive().default(60_000),
          min_turns: z.number().int().nonnegative().default(2),
          include_sidechains: z.boolean().default(false),
          exclude_globs: z.array(z.string()).default([]),
          path: z.string().optional(),
        })
        .passthrough(),
    )
    .prefault({}),

  integrations: z
    .record(
      z.string(),
      z
        .object({
          enabled: z.boolean().default(false),
          command: z.string().optional(),
          args: z.array(z.string()).default([]),
          url: z.string().optional(),
          /** Allowlist is REQUIRED. There is no wildcard — see the security model. */
          tools: z.array(z.string()),
          stages: z.array(z.string()).default(['enrichment']),
          allow_writes: z.array(z.string()).default([]),
          budget: z
            .object({
              calls_per_pass: z.number().int().positive().default(40),
              timeout_ms: z.number().int().positive().default(15_000),
            })
            .prefault({}),
        })
        .passthrough(),
    )
    .prefault({}),
})

export type Config = z.infer<typeof ConfigSchema>

export function defaults(): Config {
  return ConfigSchema.parse({})
}
