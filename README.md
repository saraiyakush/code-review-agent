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
├── code-review-agent.js  ⚠️  In Progress
├── metrics-logger.js     ✅ Implemented
└── reporter.js           ❌ Not implemented
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
