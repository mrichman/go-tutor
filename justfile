# Go Tutor — task runner. Install `just`: https://github.com/casey/just
# List recipes with `just` or `just --list`.

# Default port for the static server.
port := "5179"

# Show available recipes.
default:
    @just --list

# Serve the app locally, then open it in the browser.
serve:
    @echo "Serving Go Tutor on http://localhost:{{port}}  (Ctrl-C to stop)"
    python3 -m http.server {{port}}

# Open the app in your default browser (start `just serve` first).
open:
    open http://localhost:{{port}}/index.html

# Run the headless engine/bot/ranking/tutorial test suite.
test:
    node test/run.js

# Start the optional Claude coach proxy (needs ANTHROPIC_API_KEY in env).
coach:
    node server/coach-server.js

# Run the full local stack: static server + coach proxy together.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server {{port}} >/tmp/gotutor_http.log 2>&1 &
    HTTP_PID=$!
    node server/coach-server.js &
    COACH_PID=$!
    trap "kill $HTTP_PID $COACH_PID 2>/dev/null || true" EXIT
    echo "App:   http://localhost:{{port}}/index.html"
    echo "Coach: http://localhost:8787  (Ctrl-C to stop both)"
    wait

# Paths to your Homebrew KataGo install (version-independent symlinks).
katago_model := "/opt/homebrew/share/katago/g170e-b20c256x2-s5303129600-d1228401921.bin.gz"
katago_config := "/opt/homebrew/share/katago/configs/gtp_example.cfg"

# Start the KataGo proxy wired to your Homebrew install (strong opponent).
katago:
    #!/usr/bin/env bash
    set -euo pipefail
    export KATAGO_PATH=katago
    export KATAGO_MODEL="{{katago_model}}"
    export KATAGO_CONFIG="{{katago_config}}"
    export KATAGO_OVERRIDE="numSearchThreads=$(sysctl -n hw.ncpu),logDir=,logToStderr=false,ponderingEnabled=false,maxVisits=50"
    echo "KataGo proxy on http://localhost:8788 (first move warms up the model)"
    node server/katago-server.js

# One command: static app + KataGo proxy together. Open http://localhost:5179/index.html
play:
    #!/usr/bin/env bash
    set -euo pipefail
    python3 -m http.server {{port}} >/tmp/gotutor_http.log 2>&1 &
    HTTP_PID=$!
    export KATAGO_PATH=katago
    export KATAGO_MODEL="{{katago_model}}"
    export KATAGO_CONFIG="{{katago_config}}"
    export KATAGO_OVERRIDE="numSearchThreads=$(sysctl -n hw.ncpu),logDir=,logToStderr=false,ponderingEnabled=false,maxVisits=50"
    node server/katago-server.js &
    KATA_PID=$!
    trap "kill $HTTP_PID $KATA_PID 2>/dev/null || true" EXIT
    echo "App:    http://localhost:{{port}}/index.html"
    echo "KataGo: http://localhost:8788  (Ctrl-C to stop both)"
    wait

# Start the KataGo proxy with the built-in mock engine (no KataGo needed).
katago-mock:
    KATAGO_PATH="node" KATAGO_ARGS="server/mock-gtp.js" node server/katago-server.js

# Stop any stray static server on the configured port.
stop:
    -pkill -f "http.server {{port}}"
