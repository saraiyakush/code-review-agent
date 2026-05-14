# Introduction
A code review agent will review code on a Pull Request in Git-based version control system and post comments on the PR.

## Quality
In order to measure how good/bad the review is, a baseline data is needed to compare the before and after metrics.

# Components

## Baseline Generation Script
Pulls historical data (Gitlab/Github API), computes pre-agent metrics, stores snapshot

## Code Review Agent
Analyses diff, posts feedback as comments to a PR, calls metrics logger to record activity

## Metrics Logger
Appends structured events to an append-only central log file

## Reporter Script
Reads metrics log, compares against baseline, posts summary

# Project Structure

```
src/
├── baseline.js           ✅ Implemented
├── code-review-agent.js  ✅ Implemented
├── metrics-logger.js     ✅ Implemented
└── reporter.js           ✅ Implemented
```

# Usage

## Prerequisites

**Required Environment Variables:**
- `GITHUB_TOKEN` - GitHub personal access token with `repo` scope
- `GITHUB_OWNER` - Repository owner (e.g., `frappe`)
- `GITHUB_REPO` - Repository name (e.g., `erpnext`)
- `ANTHROPIC_API_KEY` - Anthropic API key for Claude

**Optional Environment Variables:**
- `CLAUDE_MODEL` - Model to use (default: `claude-sonnet-4-6`)
- `MAX_DIFF_SIZE` - Max diff characters to send to LLM (default: `12000`)
- `METRICS_LOG` - Metrics log file path (default: `metrics.log`)
- `OUTPUT_JSON` - Set to `true` for JSON output (for pipelines)

## Local Usage

```bash
npm install
```

### 1. Generate Baseline (Optional)

```bash
GITHUB_TOKEN=your_token node src/baseline.js
```

This creates `baseline.json` with historical PR metrics.

### 2. Review a PR

```bash
GITHUB_OWNER=owner \
GITHUB_REPO=repo \
GITHUB_TOKEN=your_token \
ANTHROPIC_API_KEY=your_key \
node src/code-review-agent.js <PR_NUMBER>
```

This reviews the PR, logs metrics to `metrics.log`, and posts a comment.

### 3. Generate Report (Optional)

```bash
node src/reporter.js
```

This creates a markdown report comparing agent performance against baseline.

## Pipeline Usage

### GitHub Actions

```yaml
name: Code Review Agent

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm install
      
      - name: Run Code Review Agent
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITHUB_OWNER: ${{ github.repository_owner }}
          GITHUB_REPO: ${{ github.event.repository.name }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          OUTPUT_JSON: true
        run: |
          node src/code-review-agent.js ${{ github.event.pull_request.number }}
```

### GitLab CI

```yaml
code_review:
  stage: review
  image: node:18
  script:
    - npm install
    - |
      GITHUB_OWNER=$CI_PROJECT_NAMESPACE \
      GITHUB_REPO=$CI_PROJECT_NAME \
      GITHUB_TOKEN=$GITHUB_TOKEN \
      ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
      OUTPUT_JSON=true \
      node src/code-review-agent.js $CI_MERGE_REQUEST_IID
  only:
    - merge_requests
```

## Output Formats

**Normal mode** (human-readable):
```
Reviewing PR #123...
── PR #123: Fix bug in baseline script
Summary: Code looks good with minor suggestions
...
```

**JSON mode** (for pipelines):
```json
{
  "success": true,
  "pr_number": 123,
  "pr_title": "Fix bug in baseline script",
  "review": { "summary": "...", "comments": [...] },
  "time_to_review_seconds": 5,
  "metrics_logged": true,
  "comment_posted": true
}
```

# Event Flow
```markdown
PR Opened
↓
Core Review Agent runs
↓
Emits structured event → metrics.log
↓
Baseline Agent compares → Reporter Agent summarises
```
