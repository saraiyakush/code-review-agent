const fs = require("fs");

const LOG_FILE = process.env.METRICS_LOG || "metrics.log";

function log(agent, event, payload) {
    const entry = {
        agent,
        event,
        timestamp: new Date().toISOString(),
        payload,
    };

    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

module.exports = { log };
