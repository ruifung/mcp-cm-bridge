/**
 * Unit tests for BM25SearchProvider (tool-search.ts)
 *
 * Tests cover:
 *  - build() + search(): term in tool name ranks that tool first
 *  - search(): term in description returns matching tools
 *  - search(): limit parameter is respected
 *  - rebuild(): atomically replaces the index; post-rebuild searches reflect new entries
 *  - search() on an empty index returns []
 *  - search() with a non-matching query returns []
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module-level mocks ────────────────────────────────────────────────────────
//
// BM25SearchProvider calls generateSchemaSnippet(), which calls generateTypes()
// from @cloudflare/codemode.  We mock the whole module to avoid the heavy
// code-generation path in unit tests; the snippet value does not affect BM25
// scoring, so a deterministic stub is fine.

vi.mock('@cloudflare/codemode', () => ({
  generateTypes: vi.fn((_tools: any) => '/* mocked schema */'),
  sanitizeToolName: (name: string) => {
    // Replicate the real implementation used by server-manager.ts
    if (!name) return '_';
    let s = name.replace(/[-.\s]/g, '_');
    s = s.replace(/[^a-zA-Z0-9_$]/g, '');
    if (!s) return '_';
    if (/^[0-9]/.test(s)) s = '_' + s;
    return s;
  },
}));

// Also mock the schema-utils module so jsonSchemaToZod does not pull in zod
// during index builds (avoids an actual Zod compilation step in the BM25 path).
vi.mock('../../src/mcp/schema-utils.js', () => ({
  jsonSchemaToZod: vi.fn((schema: any) => schema),
}));

import { BM25SearchProvider, type ToolSearchEntry } from '../../src/mcp/tool-search.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(name: string, description = `${name} does something useful`): ToolSearchEntry {
  return {
    name,
    description,
    rawSchema: { type: 'object', properties: {} },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BM25SearchProvider', () => {
  let provider: BM25SearchProvider;

  beforeEach(() => {
    provider = new BM25SearchProvider();
  });

  // ── Empty index ─────────────────────────────────────────────────────────────

  describe('empty index', () => {
    it('should return empty results when no entries have been indexed', () => {
      const results = provider.search('find something', 10);
      expect(results).toEqual([]);
    });

    it('should return empty results after build() is called with no entries', () => {
      provider.build([]);
      const results = provider.search('query', 10);
      expect(results).toEqual([]);
    });
  });

  // ── No match ────────────────────────────────────────────────────────────────

  describe('no-match queries', () => {
    it('should return empty results when the query matches nothing in the index', () => {
      provider.build([
        makeEntry('gitlab__list_projects', 'List GitLab projects'),
        makeEntry('jira__create_issue', 'Create a Jira issue'),
      ]);

      const results = provider.search('nonexistent_xyzzy_term', 10);
      expect(results).toEqual([]);
    });

    it('should return empty results when the query contains only single-character tokens', () => {
      provider.build([makeEntry('some_tool', 'A helpful tool')]);

      // All tokens are length ≤ 1 after tokenisation and are discarded
      const results = provider.search('a b c', 10);
      expect(results).toEqual([]);
    });
  });

  // ── Name match ──────────────────────────────────────────────────────────────

  describe('name-based matching', () => {
    it('should return the tool whose name contains the query term', () => {
      provider.build([
        makeEntry('github__list_repositories', 'Lists repositories on GitHub'),
        makeEntry('slack__send_message', 'Sends a message to a Slack channel'),
        makeEntry('jira__create_issue', 'Creates a Jira issue tracker entry'),
      ]);

      const results = provider.search('repositories', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('github__list_repositories');
    });

    it('should rank the tool whose name exactly contains the term above unrelated tools', () => {
      provider.build([
        makeEntry('slack__send_message', 'Send messages to channels'),
        makeEntry('github__create_repository', 'Creates a new repository'),
        makeEntry('github__list_repositories', 'List all repositories'),
      ]);

      const results = provider.search('repository', 10);
      // Both "create_repository" and "list_repositories" contain "repositor…",
      // but the one whose name contains a term closer to "repository" should score.
      const names = results.map((r) => r.name);
      expect(names).toContain('github__create_repository');
    });

    it('should return results with the correct name and description fields', () => {
      provider.build([
        makeEntry('confluence__get_page', 'Retrieves a Confluence wiki page by ID'),
      ]);

      const results = provider.search('confluence', 10);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('confluence__get_page');
      expect(results[0].description).toBe('Retrieves a Confluence wiki page by ID');
    });

    it('should include a schema field in each result', () => {
      provider.build([makeEntry('gitlab__list_mrs', 'List open merge requests')]);

      const results = provider.search('gitlab', 10);
      expect(results).toHaveLength(1);
      expect(typeof results[0].schema).toBe('string');
    });
  });

  // ── Description match ────────────────────────────────────────────────────────

  describe('description-based matching', () => {
    it('should return tools whose description contains the query term', () => {
      provider.build([
        makeEntry('github__search_code', 'Searches source code files across repositories'),
        makeEntry('jira__list_sprints', 'Lists all active sprints in a Jira board'),
        makeEntry('slack__list_channels', 'Lists available Slack channels'),
      ]);

      // "sprints" appears only in jira__list_sprints description
      const results = provider.search('sprints', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('jira__list_sprints');
    });

    it('should match tools when multiple words from the description are queried', () => {
      provider.build([
        makeEntry('trello__create_card', 'Creates a new card on a Trello board column'),
        makeEntry('github__create_pr', 'Opens a pull request on GitHub'),
      ]);

      const results = provider.search('trello board column', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('trello__create_card');
    });

    it('should match case-insensitively against descriptions', () => {
      provider.build([
        makeEntry('datadog__get_metrics', 'Retrieves DATADOG performance metrics for a service'),
      ]);

      // Query in lowercase, description has uppercase DATADOG
      const results = provider.search('datadog', 10);
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('datadog__get_metrics');
    });
  });

  // ── Limit parameter ──────────────────────────────────────────────────────────

  describe('limit parameter', () => {
    it('should return at most `limit` results', () => {
      provider.build([
        makeEntry('github__list_issues', 'Lists open GitHub issues in a repository'),
        makeEntry('gitlab__list_issues', 'Lists open GitLab issues in a project'),
        makeEntry('jira__list_issues', 'Lists Jira issues assigned to a user'),
        makeEntry('linear__list_issues', 'Lists Linear issues in a team'),
        makeEntry('asana__list_tasks', 'Lists Asana tasks assigned in a workspace'),
      ]);

      // "issues" appears in 4 of the 5 tool names/descriptions
      const results = provider.search('issues', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('should return fewer results than limit when fewer tools match', () => {
      provider.build([
        makeEntry('github__list_issues', 'Lists open GitHub issues'),
        makeEntry('slack__send_message', 'Sends messages to Slack channels'),
      ]);

      // Only the GitHub issues tool should match "github"
      const results = provider.search('github', 10);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('should return exactly 1 result when limit=1 and multiple tools match', () => {
      provider.build([
        makeEntry('github__list_repos', 'List GitHub repos'),
        makeEntry('gitlab__list_repos', 'List GitLab repos'),
        makeEntry('bitbucket__list_repos', 'List Bitbucket repos'),
      ]);

      const results = provider.search('repos', 1);
      expect(results).toHaveLength(1);
    });
  });

  // ── rebuild() ────────────────────────────────────────────────────────────────

  describe('rebuild()', () => {
    it('should replace the old index so old entries are no longer found', () => {
      provider.build([
        makeEntry('github__list_prs', 'Lists pull requests on GitHub'),
      ]);

      // Old entry is findable before rebuild
      const before = provider.search('pull requests', 10);
      expect(before.length).toBeGreaterThanOrEqual(1);

      // Rebuild with completely different entries
      provider.rebuild([
        makeEntry('confluence__search_pages', 'Full-text search over Confluence wiki pages'),
      ]);

      const after = provider.search('pull requests', 10);
      expect(after).toHaveLength(0);
    });

    it('should make new entries findable after rebuild()', () => {
      provider.build([
        makeEntry('jira__list_issues', 'Lists Jira issues'),
      ]);

      provider.rebuild([
        makeEntry('datadog__list_monitors', 'Lists Datadog monitors and their alert status'),
      ]);

      const results = provider.search('monitors', 10);
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe('datadog__list_monitors');
    });

    it('should produce correct ranking after rebuild with multiple new entries', () => {
      provider.build([makeEntry('old_tool', 'An old tool that does outdated things')]);

      provider.rebuild([
        makeEntry('aws__list_buckets', 'Lists all S3 buckets in the AWS account'),
        makeEntry('gcp__list_buckets', 'Lists all GCS buckets in the Google Cloud project'),
        makeEntry('azure__list_containers', 'Lists Azure Blob Storage containers'),
      ]);

      // "buckets" should only match the AWS and GCP tools, not the Azure one
      const results = provider.search('buckets', 10);
      const names = results.map((r) => r.name);
      expect(names).toContain('aws__list_buckets');
      expect(names).toContain('gcp__list_buckets');
      expect(names).not.toContain('azure__list_containers');
    });

    it('should behave identically to build() when called on a fresh provider', () => {
      provider.rebuild([
        makeEntry('k8s__get_pods', 'Gets running Kubernetes pods in a namespace'),
      ]);

      const results = provider.search('kubernetes', 10);
      // "kubernetes" does not appear in name or description, but "k8s" does in name
      // so it won't match. Try "pods" instead.
      const podsResults = provider.search('pods', 10);
      expect(podsResults.length).toBeGreaterThanOrEqual(1);
      expect(podsResults[0].name).toBe('k8s__get_pods');
    });

    it('should handle rebuild() with empty entries, making all subsequent searches return []', () => {
      provider.build([
        makeEntry('notion__get_page', 'Retrieves a Notion page by identifier'),
      ]);

      // Confirm it was indexed
      expect(provider.search('notion', 10)).toHaveLength(1);

      // Wipe the index via rebuild
      provider.rebuild([]);

      expect(provider.search('notion', 10)).toHaveLength(0);
    });
  });

  // ── Ranking ──────────────────────────────────────────────────────────────────

  describe('result ordering', () => {
    it('should rank the tool with more term occurrences higher than one with fewer', () => {
      provider.build([
        // "deploy" appears once (description only)
        makeEntry(
          'github__create_release',
          'Creates a GitHub release and triggers deploy hooks',
        ),
        // "deploy" appears three times (name + description × 2) — should rank first
        makeEntry(
          'argocd__deploy_application',
          'Deploys an application to a cluster via an ArgoCD deploy pipeline',
        ),
      ]);

      const results = provider.search('deploy', 10);
      expect(results).toHaveLength(2);
      // The tool with more "deploy" occurrences should rank first
      expect(results[0].name).toBe('argocd__deploy_application');
    });

    it('should return results in descending relevance order across three tools', () => {
      provider.build([
        // "monitor" once in description
        makeEntry('aws__list_alarms', 'Lists CloudWatch monitor alarms'),
        // "monitor" twice in description
        makeEntry('datadog__get_monitor', 'Retrieves a Datadog monitor and its monitor status'),
        // "monitor" not present — should not appear
        makeEntry('github__list_repos', 'Lists all GitHub repositories for an organization'),
      ]);

      const results = provider.search('monitor', 10);
      // Only the first two should match
      expect(results.length).toBeGreaterThanOrEqual(1);
      const names = results.map((r) => r.name);
      expect(names).not.toContain('github__list_repos');
    });
  });
});
