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
       * provenance — hoppr never opens them for writing. `copy` keeps our own
       * copy, needed where the upstream owner rotates the originals.
       */
      raw_mode: z.enum(['reference', 'copy']).default('copy'),
      /** Which curation stages run. */
      profile: z.enum(['folder', 'agents', 'manual']).default('manual'),
      /**
       * Convenience for `hoppr new --exclude`. `.hopprignore` beside the data
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
      track_raw: z.boolean().default(true),
      max_blob_mb: z.number().positive().default(5),
    })
    .prefault({}),

  wiki: z
    .object({
      layout: z.enum(['karpathy', 'flat']).default('karpathy'),
      /** A tag earns a concept page once this many source pages carry it. */
      concept_min_sources: z.number().int().positive().default(4),
      entity_min_mentions: z.number().int().positive().default(3),
      comparison_enabled: z.boolean().default(true),
      digest_min_new: z.number().int().positive().default(5),
      /** index.md is generated deterministically, not written by the model. */
      generate_index: z.boolean().default(true),
      claude_md: z.boolean().default(true),
    })
    .prefault({}),

  intake: z
    .object({
      inbox: z.string().default('inbox'),
      /** Scrub credentials at the extraction boundary. On by default: hoppr
       *  reads agent logs, and those contain pasted keys. */
      redact: z.boolean().default(true),
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
      concurrency: z.number().int().positive().default(2),
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
      max_raw_chars: z.number().int().positive().default(8_000),
      deep_cron: z.string().default('0 3 * * *'),
      deep_only_if_idle: z.boolean().default(true),
      /** Propose merges; never rewrite user content without review. */
      auto_merge: z.boolean().default(false),
      dedup_threshold: z.number().min(0).max(1).default(0.93),
      budget: z
        .object({
          max_usd_per_day: z.number().nonnegative().default(2.0),
          max_calls_per_run: z.number().int().positive().default(200),
        })
        .prefault({}),
    })
    .prefault({}),

  search: z
    .object({
      default_scope: z.enum(['curated', 'raw', 'all']).default('curated'),
      limit: z.number().int().positive().default(10),
      rrf_k: z.number().int().positive().default(60),
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
      /** Never true by default: a skill changes how every future session behaves. */
      auto_install: z.boolean().default(false),
      default_target: z.string().default('~/.claude/skills'),
    })
    .prefault({}),

  views: z
    .object({
      enabled: z.boolean().default(true),
      symlinks: z.boolean().default(false),
      max_items_per_index: z.number().int().positive().default(500),
    })
    .prefault({}),

  daemon: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7717),
      poll_ms: z.number().int().positive().default(2000),
      job_concurrency: z.number().int().positive().default(4),
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
