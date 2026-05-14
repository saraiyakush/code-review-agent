const https = require("https");
const fs = require("fs");

// --- Config ---
const CONFIG = {
    owner: "saraiyakush",
    repo: "code-review-agent",
    lookbackDays: 1,
    maxPages: 5,
    outputFile: "baseline.json",
    token: process.env.GITHUB_TOKEN
};

// --- HTTP Client ---
function get(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: {
                "User-Agent": "baseline-script",
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
                if (!data) {
                    reject(new Error(`Empty response from ${url}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (err) {
                    reject(new Error(`Failed to parse JSON: ${err.message}. Response: ${data.substring(0, 200)}`));
                }
            });
            res.on("error", reject);
        });
    });
}

// --- GitHub API ---
async function fetchMergedPRs() {
    const since = new Date();
    since.setDate(since.getDate() - CONFIG.lookbackDays);

    const prs = [];

    for (let page = 1; page <= CONFIG.maxPages; page++) {
        const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30&page=${page}`;
        const results = await get(url);

        if (!results.length) break;

        for (const pr of results) {
            if (!pr.merged_at) continue;
            if (new Date(pr.created_at) < since) return prs; // past lookback window
            prs.push(pr);
        }
    }

    return prs;
}

async function fetchReviews(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}/reviews`;
    return get(url);
}

async function fetchPRDetails(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}`;
    return get(url);
}

async function fetchComments(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/pulls/${prNumber}/comments`;
    return get(url);
}

async function fetchIssueComments(prNumber) {
    const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/issues/${prNumber}/comments`;
    return get(url);
}

// --- Metrics ---
function secondsBetween(a, b) {
    return Math.round((new Date(b) - new Date(a)) / 1000);
}

function average(arr) {
    if (!arr.length) return null;
    return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function buildBaseline(samples) {
    const timeToFirstReview = samples.map((s) => s.time_to_first_review_seconds).filter(Boolean);
    const timeToMerge = samples.map((s) => s.time_to_merge_seconds).filter(Boolean);
    const totalComments = samples.map((s) => s.total_comments).filter(Boolean);
    const reviewRounds = samples.map((s) => s.review_rounds).filter(Boolean);

    return {
        generated_at: new Date().toISOString(),
        repo: `${CONFIG.owner}/${CONFIG.repo}`,
        lookback_days: CONFIG.lookbackDays,
        sample_size: samples.length,
        averages: {
            time_to_first_review_seconds: average(timeToFirstReview),
            time_to_merge_seconds: average(timeToMerge),
            total_comments: average(totalComments),
            review_rounds: average(reviewRounds),
        },
        // raw samples kept for reporter to do deeper analysis if needed
        samples,
    };
}

// --- Main ---
async function run() {
    console.log(`Fetching merged PRs from ${CONFIG.owner}/${CONFIG.repo} (last ${CONFIG.lookbackDays} days)...`);

    const prs = await fetchMergedPRs();
    console.log(`Found ${prs.length} merged PRs`);

    const samples = [];

    for (const pr of prs) {
        process.stdout.write(`Processing PR #${pr.number}...`);

        const [prDetails, reviews, reviewComments, issueComments] = await Promise.all([
            fetchPRDetails(pr.number),
            fetchReviews(pr.number),
            fetchComments(pr.number),
            fetchIssueComments(pr.number)
        ]);

        const firstReview = reviews.find((r) => r.state !== "PENDING");
        const allComments = [...reviewComments, ...issueComments];
        const firstComment = allComments.sort((a, b) => 
            new Date(a.created_at) - new Date(b.created_at)
        )[0];

        const sample = {
            pr_id: pr.number,
            pr_title: pr.title,
            author: pr.user.login,
            created_at: pr.created_at,
            merged_at: pr.merged_at,
            additions: prDetails.additions,
            deletions: prDetails.deletions,
            changed_files: prDetails.changed_files,
            time_to_first_review_seconds: firstReview
                ? secondsBetween(pr.created_at, firstReview.submitted_at)
                : firstComment
                ? secondsBetween(pr.created_at, firstComment.created_at)
                : null,
            time_to_merge_seconds: secondsBetween(pr.created_at, pr.merged_at),
            total_comments: reviewComments.length + issueComments.length,
            review_rounds: reviews.filter((r) => r.state === "CHANGES_REQUESTED").length,
        };

        samples.push(sample);
        console.log(" done");
    }

    const baseline = buildBaseline(samples);
    fs.writeFileSync(CONFIG.outputFile, JSON.stringify(baseline, null, 2));
    console.log(`\nBaseline written to ${CONFIG.outputFile}`);
    console.log("Averages:", baseline.averages);
}

run().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
});