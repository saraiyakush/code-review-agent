const fs = require("fs");

// --- Config ---
const CONFIG = {
    metricsLog: process.env.METRICS_LOG || "metrics.log",
    baselineFile: process.env.BASELINE_FILE || "baseline.json",
    outputFile: process.env.REPORT_FILE || `report-${new Date().toISOString().slice(0, 10)}.md`,
};

// --- Load Data ---
function loadMetrics() {
    if (!fs.existsSync(CONFIG.metricsLog)) {
        console.error(`metrics.log not found: ${CONFIG.metricsLog}`);
        process.exit(1);
    }
    return fs
        .readFileSync(CONFIG.metricsLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line, i) => {
            try {
                return JSON.parse(line);
            } catch {
                console.warn(`Skipping malformed line ${i + 1} in metrics.log`);
                return null;
            }
        })
        .filter(Boolean);
}

function loadBaseline() {
    if (!fs.existsSync(CONFIG.baselineFile)) {
        console.warn("baseline.json not found — comparisons will be skipped.");
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(CONFIG.baselineFile, "utf8"));
    } catch {
        console.error(`Failed to parse baseline.json — check for malformed JSON.`);
        return null;
    }
}

// --- Compute ---
function average(arr) {
    if (!arr.length) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function formatSeconds(s) {
    if (s == null) return "N/A";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
}

function delta(current, baseline) {
    if (current == null || baseline == null) return "";
    const diff = current - baseline;
    const pct = Math.round((diff / baseline) * 100);
    const sign = diff < 0 ? "▼" : "▲";
    const direction = diff < 0 ? "faster" : "slower";
    return `${sign} ${Math.abs(pct)}% ${direction} vs baseline`;
}

function computeCodeReviewStats(entries) {
    const reviews = entries.filter(
        (e) => e.agent === "code-review" && e.event === "pr_reviewed"
    );
    if (!reviews.length) return null;

    const payloads = reviews.map((e) => e.payload);
    return {
        count: reviews.length,
        avg_time_to_review_seconds: average(payloads.map((p) => p.time_to_review_seconds).filter(Boolean)),
        avg_comments_posted: average(payloads.map((p) => p.comments_posted).filter(Boolean)),
        changes_requested: payloads.filter((p) => p.review_state === "changes_requested").length,
        approved: payloads.filter((p) => p.review_state === "approved").length,
    };
}

// --- Render Markdown ---
function render(stats, baseline) {
    const now = new Date().toISOString();
    const lines = [];

    lines.push(`# Code Review Agent — Report`);
    lines.push(`Generated: ${now}`);
    lines.push(``);

    // --- Summary ---
    lines.push(`## Summary`);
    if (!stats) {
        lines.push(`No code review events found in metrics.log.`);
    } else {
        lines.push(`| Metric | Agent | Baseline | Delta |`);
        lines.push(`|---|---|---|---|`);

        const bAvgReview = baseline?.averages?.time_to_first_review_seconds ?? null;
        const bAvgComments = baseline?.averages?.total_comments ?? null;

        lines.push(`| PRs Reviewed | ${stats.count} | — | — |`);
        lines.push(`| Avg LLM Processing Time | ${formatSeconds(stats.avg_time_to_review_seconds)} | — | — |`);
        lines.push(`| Avg Human Time to First Review (baseline) | — | ${formatSeconds(bAvgReview)} | — |`);
        lines.push(`| Avg Comments Posted | ${stats.avg_comments_posted ?? "N/A"} | ${bAvgComments ?? "N/A"} | — |`);
        lines.push(`| Changes Requested | ${stats.changes_requested} | — | — |`);
        lines.push(`| Approved | ${stats.approved} | — | — |`);
        lines.push(``);
        lines.push(`> ⚠️ **Note:** LLM processing time and human time-to-first-review measure different things and are not directly comparable. Once the agent posts reviews and humans respond, track \`time_from_pr_open_to_agent_comment\` for an apples-to-apples comparison.`);
    }

    lines.push(``);

    // --- Baseline Info ---
    if (baseline) {
        lines.push(`## Baseline`);
        lines.push(`- Source: \`${baseline.repo}\``);
        lines.push(`- Generated: ${baseline.generated_at}`);
        lines.push(`- Sample size: ${baseline.sample_size} PRs over ${baseline.lookback_days} days`);
        lines.push(``);
    }

    // --- Time Saved Estimate ---
    if (stats && baseline?.averages?.time_to_first_review_seconds) {
        const saved = baseline.averages.time_to_first_review_seconds - stats.avg_time_to_review_seconds;
        if (saved > 0) {
            const totalSaved = saved * stats.count;
            lines.push(`## Estimated Time Saved`);
            lines.push(`- ${formatSeconds(saved)} saved per review`);
            lines.push(`- ${formatSeconds(totalSaved)} total across ${stats.count} PRs`);
            lines.push(``);
        }
    }

    return lines.join("\n");
}

// --- Main ---
function run() {
    const entries = loadMetrics();
    const baseline = loadBaseline();
    const stats = computeCodeReviewStats(entries);

    const report = render(stats, baseline);
    try {
        fs.writeFileSync(CONFIG.outputFile, report);
        console.log(`Report written to ${CONFIG.outputFile}`);
    } catch (err) {
        console.error(`Failed to write report: ${err.message}`);
        process.exit(1);
    }
}

run();