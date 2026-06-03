/**
 * ============================================================================
 * CODE REVIEW AGENT - Automated PR Review using Claude AI
 * ============================================================================
 * 
 * This script demonstrates how to use Claude's API to automate code reviews.
 * 
 * Flow:
 * 1. Fetch PR metadata and diff from GitHub
 * 2. Send diff to Claude with review instructions (prompt)
 * 3. Parse Claude's structured JSON response
 * 4. Post review as a comment on the PR
 */

const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { log } = require("./metrics-logger");

// ============================================================================
// SECTION 1: CONFIGURATION
// ============================================================================

const CONFIG = {
    // GitHub repository details (from environment variables)
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    token: process.env.GITHUB_TOKEN,
    
    // Claude API configuration
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    
    // Token management: Limit diff size to stay within Claude's context window
    // Default 12000 chars ≈ 3000 tokens, leaving room for prompt + response
    maxDiffSize: parseInt(process.env.MAX_DIFF_SIZE || "12000")
};

// Initialize Anthropic client (API key read from ANTHROPIC_API_KEY env var)
const anthropic = new Anthropic();

// ============================================================================
// SECTION 2: GITHUB API HELPERS
// ============================================================================
// These functions fetch PR data from GitHub's REST API

/**
 * Generic GET request to GitHub API
 * Handles authentication and basic error cases
 */
function get(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "code-review-agent",
                Accept: "application/vnd.github+json",
                ...(CONFIG.token && { Authorization: `Bearer ${CONFIG.token}` }),
            },
        };
        https.get(url, options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                if (res.statusCode === 403) {
                    reject(new Error("Rate limit hit. Set GITHUB_TOKEN to increase limit."));
                    return;
                }
                resolve(JSON.parse(data));
            });
            res.on("error", reject);
        });
    });
}

/**
 * Fetch PR diff in unified diff format
 * This is what we'll send to Claude for review
 */
async function fetchPRDiff(prNumber) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "code-review-agent",
                Accept: "application/vnd.github.diff", // Request diff format, not JSON
                ...(CONFIG.token && { Authorization: `Bearer ${CONFIG.token}` }),
            },
        };
        const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}`;
        https.get(url, options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => resolve(data));
            res.on("error", reject);
        });
    });
}

/**
 * Fetch PR metadata (title, author, etc.)
 */
async function fetchPRMeta(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}`;
    return get(url);
}

// ============================================================================
// SECTION 3: LLM PROMPT ENGINEERING
// ============================================================================

/**
 * Load review instructions from external file
 * 
 * KEY CONCEPT: System Prompt vs User Prompt
 * - System prompt: Defines Claude's role, rules, and output format
 * - User prompt: Contains the actual task/data to process
 * 
 * Separating these improves consistency and makes prompt iteration easier
 */
const REVIEW_PROMPT = fs.readFileSync(
    path.join(__dirname, "review-prompt.md"),
    "utf8"
);

// ============================================================================
// SECTION 4: GITHUB COMMENT FORMATTING
// ============================================================================

/**
 * Post review comment to GitHub PR
 */
function postPRComment(prNumber, body) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ body });
        const options = {
            hostname: "api.github.com",
            path: `/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${prNumber}/comments`,
            method: "POST",
            headers: {
                "User-Agent": "code-review-agent",
                Accept: "application/vnd.github+json",
                ...(CONFIG.token && { Authorization: `Bearer ${CONFIG.token}` }),
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                if (res.statusCode === 201) resolve(JSON.parse(data));
                else reject(new Error(`Failed to post comment: ${res.statusCode} ${data}`));
            });
        });

        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

/**
 * Format Claude's JSON response as a nice markdown comment
 */
function formatReviewAsComment(review) {
    const iconMap = { critical: "🔴", warning: "🟡", suggestion: "🔵" };
    const lines = [
        `## 🤖 Automated Code Review`,
        ``,
        `**Summary:** ${review.summary}`,
        ``,
        `---`,
    ];

    for (const comment of review.comments || []) {
        const icon = iconMap[comment.severity] || "⚪";
        lines.push(`### ${icon} ${comment.severity.toUpperCase()} — \`${comment.file}\``);
        lines.push(`**Issue:** ${comment.issue}`);
        lines.push(``);
        lines.push(`**Suggestion:** ${comment.suggestion}`);
        lines.push(``);
    }

    lines.push(`---`);
    lines.push(`*Posted by code-review-agent using Claude ${CONFIG.model}*`);
    return lines.join("\n");
}

// ============================================================================
// SECTION 5: CORE REVIEW LOGIC (⭐ THE MAIN EVENT)
// ============================================================================

/**
 * Main function: Review a PR using Claude AI
 * 
 * This is where everything comes together:
 * 1. Fetch PR data from GitHub
 * 2. Call Claude's API with the diff
 * 3. Parse and validate the response
 * 4. Post the review back to GitHub
 */
async function reviewPR(prNumber) {
    console.log(`\nReviewing PR #${prNumber}...`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
        // Step 1: Fetch PR metadata and diff from GitHub
        const [meta, diff] = await Promise.all([
            fetchPRMeta(prNumber),
            fetchPRDiff(prNumber),
        ]);

        if (!diff || diff.length < 10) {
            console.log("No diff available.");
            return {
                success: false,
                pr_number: prNumber,
                error: "No diff available",
            };
        }

        // Step 2: Handle token limits
        // Claude has a context window limit. If the diff is too large, truncate it.
        // This is a simple strategy - production systems might use smarter chunking.
        const truncatedDiff = diff.length > CONFIG.maxDiffSize 
            ? diff.slice(0, CONFIG.maxDiffSize) + "\n...[truncated]" 
            : diff;

        // ========================================================================
        // ⭐ STEP 3: CALL CLAUDE'S API (THE KEY PART FOR YOUR DEMO)
        // ========================================================================
        
        /**
         * KEY CONCEPTS TO EXPLAIN:
         * 
         * 1. System Prompt (REVIEW_PROMPT):
         *    - Defines Claude's role as a code reviewer
         *    - Sets the rules and priorities
         *    - Specifies the output format (JSON)
         *    - Loaded from external file for easy iteration
         * 
         * 2. User Prompt:
         *    - Contains the actual task: "Review this PR"
         *    - Includes the PR title and diff
         *    - Kept separate from instructions for clarity
         * 
         * 3. Model Selection:
         *    - claude-sonnet-4-6: Fast, cost-effective, good for code
         *    - Could use opus for more complex reviews
         * 
         * 4. max_tokens:
         *    - Limits the response length
         *    - 1024 tokens ≈ 750 words, enough for most reviews
         */
        const message = await anthropic.messages.create({
            model: CONFIG.model,
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: `${REVIEW_PROMPT} Review this pull request:\n\nTitle: ${meta.title}\n\nDiff:\n${truncatedDiff}`,
                },
            ],
        });

        // Step 4: Extract text from Claude's response
        // Claude returns an array of content blocks; we want the text block
        const responseText = message.content.find((b) => b.type === "text")?.text || "";

        // ========================================================================
        // STEP 5: PARSE CLAUDE'S RESPONSE
        // ========================================================================
        
        let review;
        try {
            /**
             * COMMON ISSUE: Claude sometimes wraps JSON in markdown code fences
             * despite being told not to. We handle this defensively.
             * 
             * Example response:
             * ```json
             * {"summary": "...", "comments": [...]}
             * ```
             * 
             * We strip the fences before parsing.
             */
            const cleanedText = responseText
                .replace(/^```json\s*\n?/i, "")  // Remove opening fence
                .replace(/\n?```\s*$/i, "");      // Remove closing fence
            
            review = JSON.parse(cleanedText);
        } catch {
            console.error("Failed to parse review response:", responseText);
            return {
                success: false,
                pr_number: prNumber,
                error: "Failed to parse LLM response",
                raw_response: responseText,
            };
        }

        const timeToReviewSeconds = Math.round((Date.now() - startMs) / 1000);

        // Step 6: Log metrics for evaluation (optional, can skip in demo)
        try {
            log("code-review", "pr_reviewed", {
                pr_id: String(prNumber),
                pr_title: meta.title,
                author: meta.user?.login,
                created_at: meta.created_at,
                reviewed_at: new Date().toISOString(),
                time_to_review_seconds: timeToReviewSeconds,
                comments_posted: review.comments?.length || 0,
                review_state: review.comments?.some((c) => c.severity === "critical")
                    ? "changes_requested"
                    : "approved",
            });
        } catch (err) {
            console.warn(`Failed to log metrics: ${err.message}`);
        }

        // Step 7: Display review in console
        console.log(`\n── PR #${prNumber}: ${meta.title}`);
        console.log(`Summary: ${review.summary}`);
        console.log(`\nComments (${review.comments?.length || 0}):`);

        for (const comment of review.comments || []) {
            const icon = comment.severity === "critical" ? "🔴" : comment.severity === "warning" ? "🟡" : "🔵";
            console.log(`\n${icon} [${comment.severity.toUpperCase()}] ${comment.file}`);
            console.log(`   Issue: ${comment.issue}`);
            console.log(`   Fix:   ${comment.suggestion}`);
        }

        console.log(`\nReview completed in ${timeToReviewSeconds}s`);

        // Step 8: Post review as a comment on the PR
        let commentPosted = false;
        try {
            const commentBody = formatReviewAsComment(review);
            await postPRComment(prNumber, commentBody);
            console.log("Review posted as PR comment.");
            commentPosted = true;
        } catch (err) {
            console.warn(`Could not post comment: ${err.message}`);
        }

        // Return structured result (useful for CI/CD pipelines)
        return {
            success: true,
            pr_number: prNumber,
            pr_title: meta.title,
            review,
            time_to_review_seconds: timeToReviewSeconds,
            metrics_logged: true,
            comment_posted: commentPosted,
        };
    } catch (err) {
        console.error(`Error reviewing PR: ${err.message}`);
        return {
            success: false,
            pr_number: prNumber,
            error: err.message,
        };
    }
}

// ============================================================================
// SECTION 6: CLI ENTRY POINT
// ============================================================================

/**
 * Main entry point when run from command line
 * 
 * Usage:
 *   GITHUB_OWNER=owner GITHUB_REPO=repo node src/code-review-agent.js 123
 */
async function run() {
    const prNumber = process.argv[2];

    // Validate inputs
    if (!prNumber) {
        console.error("Usage: node code-review-agent.js <PR_NUMBER>");
        console.error("Required env vars: GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN");
        process.exit(1);
    }

    if (!CONFIG.owner || !CONFIG.repo) {
        console.error("Error: GITHUB_OWNER and GITHUB_REPO env vars are required");
        process.exit(1);
    }

    if (!CONFIG.token) {
        console.error("Error: GITHUB_TOKEN env var is required");
        process.exit(1);
    }

    // Run the review
    const result = await reviewPR(parseInt(prNumber));
    
    
    // Exit with appropriate code for automation
    process.exit(result?.success === false ? 1 : 0);
}

// Handle uncaught errors gracefully
run().catch((err) => {
    console.error("Error:", err.message);
    
    if (process.env.OUTPUT_JSON === "true") {
        console.log(JSON.stringify({ success: false, error: err.message }));
    }
    
    process.exit(1);
});
