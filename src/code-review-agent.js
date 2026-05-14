const Anthropic = require("@anthropic-ai/sdk");
const https = require("https");
const { log } = require("./metrics-logger");

// --- Config ---
const CONFIG = {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    token: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    maxDiffSize: parseInt(process.env.MAX_DIFF_SIZE || "12000")
};

const anthropic = new Anthropic();

// --- GitHub API ---
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

async function fetchPRDiff(prNumber) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "code-review-agent",
                Accept: "application/vnd.github.diff",
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

async function fetchPRMeta(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}`;
    return get(url);
}

// --- Review Rules ---
const REVIEW_PROMPT = `You are a senior code reviewer. Review the following PR diff and provide concise, actionable feedback.

Focus on:
- Bugs or logic errors
- Security issues
- Missing error handling
- Performance concerns
- Code clarity

Format your response as a JSON object with this structure:
{
  "summary": "One sentence overall assessment",
  "comments": [
    {
      "severity": "critical | warning | suggestion",
      "file": "filename or 'general'",
      "issue": "What the problem is",
      "suggestion": "How to fix it"
    }
  ]
}

Return only valid JSON, no markdown fences.`;

// --- Post Comment to GitHub ---
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
        lines.push(`**Suggestion:** ${comment.suggestion}`);
        lines.push(``);
    }

    lines.push(`---`);
    lines.push(`*Posted by code-review-agent using Claude ${CONFIG.model}*`);
    return lines.join("\n");
}

// --- Core ---
async function reviewPR(prNumber) {
    console.log(`\nReviewing PR #${prNumber}...`);
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
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

        // Truncate large diffs to stay within token limits
        const truncatedDiff = diff.length > CONFIG.maxDiffSize ? diff.slice(0, CONFIG.maxDiffSize) + "\n...[truncated]" : diff;

        const message = await anthropic.messages.create({
            model: CONFIG.model,
            max_tokens: 1024,
            messages: [
                {
                    role: "user",
                    content: `${REVIEW_PROMPT}\n\nPR Title: ${meta.title}\n\nDiff:\n${truncatedDiff}`,
                },
            ],
        });

        const responseText = message.content.find((b) => b.type === "text")?.text || "";
        let review;

        try {
            // Strip markdown code fences if present
            const cleanedText = responseText.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/i, "");
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

        // --- Log metrics event ---
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

        // --- Output ---
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

        // --- Post to GitHub ---
        let commentPosted = false;
        try {
            const commentBody = formatReviewAsComment(review);
            await postPRComment(prNumber, commentBody);
            console.log("Review posted as PR comment.");
            commentPosted = true;
        } catch (err) {
            console.warn(`Could not post comment: ${err.message}`);
        }

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

// --- Main ---
async function run() {
    const prNumber = process.argv[2];

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

    const result = await reviewPR(parseInt(prNumber));
        
    process.exit(result?.success === false ? 1 : 0);
}

run().catch((err) => {
    console.error("Error:", err.message);
        
    process.exit(1);
});
