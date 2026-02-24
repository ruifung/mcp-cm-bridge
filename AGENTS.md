# Agent State Documentation

This file documents the structure and contents of the `agent-state/` directory, which contains analysis, investigation, and planning documents created during agentic development sessions.

## Directory Structure

```
agent-state/
├── AGENTS.md (this file)
├── Executor Implementation Docs
│   ├── EXECUTOR_COMPARISON.md
│   ├── EXECUTOR_STATUS_REPORT.md
│   └── EXECUTOR_TEST_RESULTS.md
├── Isolated-VM Investigation
│   ├── ISOLATED_VM_ANALYSIS_SUMMARY.md
│   ├── ISOLATED_VM_CALLBACK_ISSUE.md
│   ├── ISOLATED_VM_ISSUES_EXPLAINED.md
│   ├── ISOLATED_VM_QUICK_START.md
│   ├── ISOLATED_VM_SETUP.md
│   └── ISOLATE_VM_INVESTIGATION.md
├── Architecture & Comparison
│   ├── ARCHITECTURE_COMPARISON.md
│   └── PROTOTYPE_POLLUTION_ANALYSIS.md
```

## File Guide

### Executor Comparison & Status

- **EXECUTOR_COMPARISON.md** - Comprehensive comparison between vm2 and isolated-vm executors, including security analysis, performance characteristics, and deployment recommendations.

- **EXECUTOR_STATUS_REPORT.md** - Current status of executor implementations, test pass/fail rates, and identified issues across both implementations.

- **EXECUTOR_TEST_RESULTS.md** - Detailed test results and findings from the executor test suite, including security validation tests and performance benchmarks.

### Isolated-VM Investigation

The isolated-vm executor was investigated as an alternative to vm2 for better security isolation. This series of documents tracks the investigation, discovery of callback boundary issues, and analysis of solutions.

- **ISOLATE_VM_INVESTIGATION.md** - Initial investigation into isolated-vm as a sandbox alternative, setup process, and initial testing results.

- **ISOLATED_VM_SETUP.md** - Step-by-step setup guide for isolated-vm, native compilation requirements, and configuration options.

- **ISOLATED_VM_QUICK_START.md** - Quick evaluation guide for deciding between vm2 and isolated-vm for specific use cases.

- **ISOLATED_VM_CALLBACK_ISSUE.md** - Deep technical analysis of the core problem: async Callback return values cannot cross the isolate boundary, preventing tool function return values from being retrieved.

- **ISOLATED_VM_ANALYSIS_SUMMARY.md** - Decision matrix comparing different solution approaches (Custom Result Protocol, Two-stage Callback, Direct Result Storage, etc.).

- **ISOLATED_VM_ISSUES_EXPLAINED.md** - Clear, concise explanation of the isolated-vm callback issue suitable for quick reference during development.

### Architecture & Security

- **ARCHITECTURE_COMPARISON.md** - Detailed architectural comparison of vm2 vs isolated-vm including memory layouts, execution models, security vectors, and deployment considerations.

- **PROTOTYPE_POLLUTION_ANALYSIS.md** - Analysis of how the two executors handle prototype pollution attacks and the security implications of each approach.

## Purpose of This Directory

These documents serve as:

1. **Investigation Records** - Tracking the exploration of isolated-vm as an executor alternative
2. **Analysis Archive** - Detailed technical analysis for future reference
3. **Decision Documentation** - Reasoning behind architectural choices
4. **Problem Reference** - Quick lookup for known issues and their root causes

## Why This Directory is Gitignored

The `agent-state/` directory is excluded from version control because:

- These are working documents created during development sessions
- They contain intermediate analysis that may become outdated
- The actual implementation code is tracked in git; these docs are for context only
- Agent-generated analysis is best kept as local reference material

## Current Active Issues

### Isolated-VM Executor

**Status:** Implementation complete, 6 tests failing

**Issue:** Tool functions cannot return values across isolate boundary due to async Callback limitations.

**Failing Tests:**
- should invoke tool functions
- should pass arguments to tool functions
- should support tool with object arguments
- should handle async/await chains
- should isolate data between concurrent executions
- (one additional security/prototype test)

**Root Cause:** The `{ async: true }` Callback flag wraps return values in Promises, which cannot be serialized across the isolate boundary, causing tool functions to return `undefined` instead of actual values.

**Solution Approaches Being Explored:**
1. Custom Result Protocol - Store results in host-side Map, return only call IDs
2. Two-stage Callback - First callback returns ID, second retrieves actual result
3. Direct Result Storage - Store results in globals, extract via context.eval()
4. Alternative Callback Signature - Pass result callback TO the tool function

**Next Steps:** Implement and test one of the above approaches to bridge the return value crossing issue.

## How to Use This Directory

1. **For Quick Reference:** Start with `ISOLATED_VM_ISSUES_EXPLAINED.md` for a concise problem overview
2. **For Deep Dive:** Read `ISOLATED_VM_CALLBACK_ISSUE.md` for technical details
3. **For Architecture Context:** Review `ARCHITECTURE_COMPARISON.md` and `EXECUTOR_COMPARISON.md`
4. **For Current Status:** Check `EXECUTOR_STATUS_REPORT.md` and test results

---

**Last Updated:** 2026-02-25  
**Maintainer:** OpenCode (agentic)
