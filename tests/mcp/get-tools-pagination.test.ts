/**
 * Unit tests for paginateToolList (server.ts)
 *
 * Tests the pure pagination helper that slices a flat tool list into pages,
 * groups results by server, and encodes/decodes base64url cursors.
 *
 * No mocks are needed — paginateToolList is a pure function with no I/O.
 *
 * Mode: TDD  (implementation not yet written; tests are expected to fail until
 *             `paginateToolList` is exported from src/mcp/server.ts)
 */

import { describe, it, expect } from 'vitest';
import { paginateToolList } from '../../src/mcp/server.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTools(count: number, server = 'test-server') {
  return Array.from({ length: count }, (_, i) => ({
    server,
    name: `${server}__tool_${i}`,
    description: `Tool ${i}`,
  }));
}

/** Encodes a cursor the same way the implementation is expected to. */
function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Flatten paginateToolList's grouped output back to a simple list so tests can
 * compare against the original flat fixture without re-grouping.
 */
function flattenData(
  data: Array<{ server: string; tools: Array<{ name: string; description: string }> }>,
): Array<{ server: string; name: string; description: string }> {
  return data.flatMap(({ server, tools }) =>
    tools.map((t) => ({ server, ...t })),
  );
}

// ── Basic pagination ──────────────────────────────────────────────────────────

describe('paginateToolList — basic pagination', () => {
  it('should return empty data and totalTools:0 when tool list is empty', () => {
    const result = paginateToolList({ tools: [], pageSize: 10 });

    expect(result).toEqual({ data: [], totalTools: 0 });
    expect((result as any).nextCursor).toBeUndefined();
  });

  it('should return all tools and no nextCursor when list is smaller than pageSize', () => {
    const tools = makeTools(3);
    const result = paginateToolList({ tools, pageSize: 10 });

    expect((result as any).error).toBeUndefined();
    const out = result as { data: any[]; totalTools: number; nextCursor?: string };

    expect(out.totalTools).toBe(3);
    expect(flattenData(out.data)).toHaveLength(3);
    expect(out.nextCursor).toBeUndefined();
  });

  it('should return all tools and no nextCursor when list equals pageSize exactly', () => {
    const tools = makeTools(5);
    const result = paginateToolList({ tools, pageSize: 5 });

    expect((result as any).error).toBeUndefined();
    const out = result as { data: any[]; totalTools: number; nextCursor?: string };

    expect(out.totalTools).toBe(5);
    expect(flattenData(out.data)).toHaveLength(5);
    expect(out.nextCursor).toBeUndefined();
  });

  it('should return first page with nextCursor when list is larger than pageSize', () => {
    const tools = makeTools(8);
    const result = paginateToolList({ tools, pageSize: 3 });

    expect((result as any).error).toBeUndefined();
    const out = result as { data: any[]; totalTools: number; nextCursor?: string };

    expect(out.totalTools).toBe(8);
    expect(flattenData(out.data)).toHaveLength(3);
    // nextCursor must encode offset 3 (the start of the next page)
    expect(out.nextCursor).toBe(encodeCursor(3));
  });

  it('should return the correct second page when using nextCursor from first response', () => {
    const tools = makeTools(8);
    const firstPage = paginateToolList({ tools, pageSize: 3 }) as {
      data: any[];
      nextCursor?: string;
      totalTools: number;
    };

    expect(firstPage.nextCursor).toBeDefined();

    const secondPage = paginateToolList({
      tools,
      cursor: firstPage.nextCursor,
      pageSize: 3,
    }) as { data: any[]; nextCursor?: string; totalTools: number };

    expect((secondPage as any).error).toBeUndefined();
    const flat = flattenData(secondPage.data);
    expect(flat).toHaveLength(3);
    // Second page should contain tools 3, 4, 5
    expect(flat.map((t) => t.name)).toEqual([
      'test-server__tool_3',
      'test-server__tool_4',
      'test-server__tool_5',
    ]);
    expect(secondPage.nextCursor).toBe(encodeCursor(6));
  });

  it('should return remaining tools and no nextCursor on the last page', () => {
    const tools = makeTools(7);
    // Jump straight to the last page (offset 6 → 1 remaining tool)
    const result = paginateToolList({
      tools,
      cursor: encodeCursor(6),
      pageSize: 3,
    }) as { data: any[]; nextCursor?: string; totalTools: number };

    expect((result as any).error).toBeUndefined();
    expect(flattenData(result.data)).toHaveLength(1);
    expect(result.nextCursor).toBeUndefined();
    expect(result.totalTools).toBe(7);
  });
});

// ── Server grouping ───────────────────────────────────────────────────────────

describe('paginateToolList — server grouping', () => {
  it('should group tools from multiple servers correctly in data', () => {
    const alphaTools = makeTools(2, 'alpha-server');
    const betaTools = makeTools(3, 'beta-server');
    const tools = [...alphaTools, ...betaTools];

    const result = paginateToolList({ tools, pageSize: 10 }) as {
      data: Array<{ server: string; tools: Array<{ name: string; description: string }> }>;
      totalTools: number;
      nextCursor?: string;
    };

    expect((result as any).error).toBeUndefined();
    expect(result.totalTools).toBe(5);

    const alphaGroup = result.data.find((g) => g.server === 'alpha-server');
    const betaGroup = result.data.find((g) => g.server === 'beta-server');

    expect(alphaGroup).toBeDefined();
    expect(betaGroup).toBeDefined();
    expect(alphaGroup!.tools).toHaveLength(2);
    expect(betaGroup!.tools).toHaveLength(3);
    // Each tool entry inside the group should NOT include the server field again
    expect(Object.keys(alphaGroup!.tools[0])).toContain('name');
    expect(Object.keys(alphaGroup!.tools[0])).toContain('description');
  });

  it('should paginate only the filtered server tools when a server filter is applied before pagination', () => {
    const alphaTools = makeTools(10, 'alpha-server');
    const betaTools = makeTools(5, 'beta-server');
    // Caller is expected to filter before calling paginateToolList
    const filteredTools = [...alphaTools, ...betaTools].filter(
      (t) => t.server === 'alpha-server',
    );

    const result = paginateToolList({ tools: filteredTools, pageSize: 4 }) as {
      data: Array<{ server: string; tools: Array<{ name: string; description: string }> }>;
      totalTools: number;
      nextCursor?: string;
    };

    expect((result as any).error).toBeUndefined();
    // totalTools reflects only filtered tools
    expect(result.totalTools).toBe(10);
    // Only one server group on this page
    expect(result.data.every((g) => g.server === 'alpha-server')).toBe(true);
    expect(flattenData(result.data)).toHaveLength(4);
    expect(result.nextCursor).toBe(encodeCursor(4));
  });
});

// ── Cursor edge cases ─────────────────────────────────────────────────────────

describe('paginateToolList — cursor edge cases', () => {
  it('should return { error: "Invalid cursor" } for a random non-base64url string', () => {
    const result = paginateToolList({
      tools: makeTools(5),
      cursor: 'not-a-valid-cursor!!!',
      pageSize: 10,
    });

    expect(result).toEqual({ error: 'Invalid cursor' });
  });

  it('should return empty data and no nextCursor when cursor offset points past end of list', () => {
    const tools = makeTools(5);
    const result = paginateToolList({
      tools,
      cursor: encodeCursor(100),
      pageSize: 10,
    }) as { data: any[]; nextCursor?: string; totalTools: number };

    expect((result as any).error).toBeUndefined();
    expect(flattenData(result.data)).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
    // totalTools must still reflect full list
    expect(result.totalTools).toBe(5);
  });

  it('should behave the same as no cursor when cursor encodes offset 0', () => {
    const tools = makeTools(6);
    const withCursor = paginateToolList({
      tools,
      cursor: encodeCursor(0),
      pageSize: 4,
    });
    const withoutCursor = paginateToolList({ tools, pageSize: 4 });

    expect(withCursor).toEqual(withoutCursor);
  });

  it('should return { error: "Invalid cursor" } for malformed base64url that decodes to garbage', () => {
    // This is valid base64url characters but the decoded bytes are not valid JSON
    const malformed = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url');
    const result = paginateToolList({
      tools: makeTools(5),
      cursor: malformed,
      pageSize: 10,
    });

    expect(result).toEqual({ error: 'Invalid cursor' });
  });

  it('should return { error: "Invalid cursor" } for valid JSON base64url but wrong shape', () => {
    // Valid base64url, valid JSON, but missing the expected `o` field
    const wrongShape = Buffer.from(JSON.stringify({ x: 5 })).toString('base64url');
    const result = paginateToolList({
      tools: makeTools(5),
      cursor: wrongShape,
      pageSize: 10,
    });

    expect(result).toEqual({ error: 'Invalid cursor' });
  });
});

// ── Page size edge cases ──────────────────────────────────────────────────────

describe('paginateToolList — page size', () => {
  it('should return exactly one tool per page when pageSize is 1', () => {
    const tools = makeTools(3);

    const page1 = paginateToolList({ tools, pageSize: 1 }) as {
      data: any[];
      nextCursor?: string;
      totalTools: number;
    };
    expect(flattenData(page1.data)).toHaveLength(1);
    expect(flattenData(page1.data)[0].name).toBe('test-server__tool_0');
    expect(page1.nextCursor).toBe(encodeCursor(1));

    const page2 = paginateToolList({
      tools,
      cursor: page1.nextCursor,
      pageSize: 1,
    }) as { data: any[]; nextCursor?: string; totalTools: number };
    expect(flattenData(page2.data)).toHaveLength(1);
    expect(flattenData(page2.data)[0].name).toBe('test-server__tool_1');
    expect(page2.nextCursor).toBe(encodeCursor(2));

    const page3 = paginateToolList({
      tools,
      cursor: page2.nextCursor,
      pageSize: 1,
    }) as { data: any[]; nextCursor?: string; totalTools: number };
    expect(flattenData(page3.data)).toHaveLength(1);
    expect(flattenData(page3.data)[0].name).toBe('test-server__tool_2');
    expect(page3.nextCursor).toBeUndefined();
  });

  it('should traverse all pages via cursors and see every tool exactly once', () => {
    const tools = makeTools(11);
    const pageSize = 4;
    const seen: string[] = [];

    let cursor: string | undefined = undefined;
    let iterations = 0;
    const MAX_ITERATIONS = 20; // guard against infinite loop in a broken impl

    do {
      const result = paginateToolList({ tools, cursor, pageSize }) as {
        data: any[];
        nextCursor?: string;
        totalTools: number;
      };

      expect((result as any).error).toBeUndefined();
      flattenData(result.data).forEach((t) => seen.push(t.name));
      cursor = result.nextCursor;
      iterations++;
    } while (cursor !== undefined && iterations < MAX_ITERATIONS);

    expect(iterations).toBeLessThan(MAX_ITERATIONS); // must have terminated naturally

    // Every tool seen exactly once
    expect(seen).toHaveLength(11);
    const expectedNames = tools.map((t) => t.name);
    expect(seen).toEqual(expectedNames);
  });
});
